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
