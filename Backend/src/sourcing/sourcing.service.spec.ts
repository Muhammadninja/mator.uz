// deleteTicket must clean up the customer's dangling SOURCING_OFFER
// notifications (the offers cascade-delete, the notifications don't).

import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
  return { service: new SourcingService(prisma as never), prisma };
}

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
    return { prisma, service: new SourcingService(prisma as never) };
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
    return { update, service: new SourcingService({ sourcingTicket: { update } } as never) };
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
