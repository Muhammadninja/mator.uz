// deleteTicket must clean up the customer's dangling SOURCING_OFFER
// notifications (the offers cascade-delete, the notifications don't).

import { NotFoundException } from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  PackageForm,
  Prisma,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FISCAL_CODES_UNCONFIRMED } from '../common/fiscal.util';
import { confirmedCategory } from '../../test/utils/harness';
import { ClassifySourcingOfferDto } from './dto/classify-sourcing-offer.dto';
import { SourcingService } from './sourcing.service';

function build(overrides: Record<string, unknown> = {}) {
  const prisma = {
    sourcingOffer: {
      findMany: jest.fn(async () => [{ id: 'soff_1' }, { id: 'soff_2' }]),
    },
    sourcingTicket: {
      delete: jest.fn(async () => ({ id: 'ticket-1' })),
    },
    notification: {
      deleteMany: jest.fn(async () => ({ count: 2 })),
    },
    ...overrides,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new SourcingService(prisma as never, audit as never),
    prisma,
    audit,
  };
}

describe('SourcingService.classifyOffer', () => {
  const classifying = (category: unknown) => {
    const tx = {
      sourcingOffer: {
        findUnique: jest.fn(async () => ({
          id: 'soff_1',
          categoryId: null,
          packageForm: null,
        })),
        update: jest.fn(async () => ({})),
      },
      partCategory: { findUnique: jest.fn(async () => category) },
    };
    return build({
      ...tx,
      $transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
    });
  };
  const ctx = { actor: { id: 'adm_1', email: 'a@b.c', name: 'A' } };

  it('writes the classification and audits who decided what', async () => {
    const { service, prisma, audit } = classifying(confirmedCategory());

    const res = await service.classifyOffer(
      'soff_1',
      { categoryId: 'brakes', packageForm: PackageForm.SET },
      ctx,
    );

    expect((prisma as any).sourcingOffer.update).toHaveBeenCalledWith({
      where: { id: 'soff_1' },
      data: { categoryId: 'brakes', packageForm: PackageForm.SET },
    });
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: AdminAuditAction.SOURCING_OFFER_CLASSIFIED,
      target: { entity: AdminAuditEntity.SOURCING_OFFER, id: 'soff_1' },
      newValues: { categoryId: 'brakes', packageForm: PackageForm.SET },
    });
    // A confirmed category: nothing stands between this offer and a receipt.
    expect(res.data.fiscalGaps).toEqual([]);
  });

  it('reports what the receipt would still lack: a category nobody confirmed', async () => {
    const { service } = classifying({
      ...confirmedCategory(),
      fiscalConfirmedCodes: null,
    });
    const res = await service.classifyOffer('soff_1', { categoryId: 'brakes' });
    expect(res.data.fiscalGaps).toEqual([FISCAL_CODES_UNCONFIRMED]);
  });

  it('clearing the category makes the offer unpayable again', async () => {
    const { service, prisma } = classifying(null);
    const res = await service.classifyOffer('soff_1', { categoryId: null });
    expect((prisma as any).sourcingOffer.update).toHaveBeenCalledWith({
      where: { id: 'soff_1' },
      data: { categoryId: null, packageForm: null },
    });
    expect(res.data.fiscalGaps).toEqual(['the offer has no category']);
  });

  it('404s on an unknown category and writes nothing', async () => {
    const { service, prisma, audit } = classifying(null);
    await expect(
      service.classifyOffer('soff_1', { categoryId: 'no-such' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((prisma as any).sourcingOffer.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('takes null to clear the category, but a blank is a bad request, not a clear', async () => {
    const errorsFor = (body: object) =>
      validate(plainToInstance(ClassifySourcingOfferDto, body));

    expect(await errorsFor({ categoryId: null })).toHaveLength(0);
    expect(await errorsFor({})).toHaveLength(0);
    expect(await errorsFor({ categoryId: '' })).toHaveLength(1);
  });
});

describe('SourcingService.deleteTicket', () => {
  it('deletes the ticket and cleans up its offer notifications', async () => {
    const { service, prisma } = build();

    await service.deleteTicket('ticket-1');

    expect(prisma.sourcingTicket.delete).toHaveBeenCalledWith({ where: { id: 'ticket-1' } });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: {
        type: 'SOURCING_OFFER',
        deeplinkPath: { in: ['/sourcing/offer/soff_1', '/sourcing/offer/soff_2'] },
      },
    });
  });

  it('skips notification cleanup when the ticket had no offers', async () => {
    const { service, prisma } = build({
      sourcingOffer: { findMany: jest.fn(async () => []) },
    });

    await service.deleteTicket('ticket-1');

    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
  });

  it('never fails the delete if notification cleanup throws', async () => {
    const { service } = build({
      notification: { deleteMany: jest.fn(async () => { throw new Error('db down'); }) },
    });

    await expect(service.deleteTicket('ticket-1')).resolves.toBeUndefined();
  });

  it('throws NotFoundException when the ticket does not exist', async () => {
    const { service } = build({
      sourcingTicket: {
        delete: jest.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('missing', {
            code: 'P2025',
            clientVersion: 'x',
          });
        }),
      },
    });

    await expect(service.deleteTicket('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SourcingService — staff view of the customer', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  function withUser(user: Record<string, unknown>, userId: string | null = USER) {
    const prisma = {
      sourcingTicket: { count: jest.fn(), findMany: jest.fn() },
      appUser: { findMany: jest.fn(async () => [{ id: USER, ...user }]) },
      $transaction: jest.fn(async () => [1, [{ id: 't1', userId }]]),
    };
    return { prisma, service: new SourcingService(prisma as never, {} as never) };
  }
  const contact = { displayName: 'Иван', firstName: null, lastName: null, phoneE164: '+998901234567' };

  it('includes a verified phone number', async () => {
    const { service } = withUser({ ...contact, phoneVerified: true });
    const { data } = await service.findAllForAdmin({} as never);
    expect(data[0].customer).toEqual({ name: 'Иван', phone: '+998901234567' });
  });

  it('leaves out an unverified one', async () => {
    const { service } = withUser({ ...contact, phoneVerified: false });
    const { data } = await service.findAllForAdmin({} as never);
    expect(data[0].customer).toEqual({ name: 'Иван', phone: null });
  });

  it('tolerates old tickets whose owner id is not a real uuid', async () => {
    const { service, prisma } = withUser(contact, 'client-supplied');
    const { data } = await service.findAllForAdmin({} as never);
    expect(prisma.appUser.findMany).not.toHaveBeenCalled();
    expect(data[0].customer).toBeNull();
  });
});

describe('SourcingService.updateStatus — customer notices', () => {
  function withTicket(ticket: Record<string, unknown>) {
    const update = jest.fn(async ({ data }: any) => ({ ...ticket, ...data }));
    return {
      update,
      service: new SourcingService({ sourcingTicket: { update } } as never, {} as never),
    };
  }

  it('queues a notice for a ticket from the new flow', async () => {
    const { service, update } = withTicket({ id: 't1', requestId: 'r1' });
    const ticket = await service.updateStatus('t1', 'IN_PROGRESS');
    expect(update).toHaveBeenCalledTimes(2);
    expect(ticket.customerNotice).toBe('IN_PROGRESS');
  });

  it('leaves older tickets alone', async () => {
    const { service, update } = withTicket({ id: 't1', requestId: null });
    await service.updateStatus('t1', 'CLOSED');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('has nothing to say for a status with no notice', async () => {
    const { service, update } = withTicket({ id: 't1', requestId: 'r1' });
    await service.updateStatus('t1', 'OFFERED');
    expect(update).toHaveBeenCalledTimes(1);
  });
});
