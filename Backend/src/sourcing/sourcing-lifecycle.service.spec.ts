import { SourcingLifecycleService } from './sourcing-lifecycle.service';

function build(ticket: Record<string, unknown> = {}) {
  const row = { id: 't1', staffNotifyAttempts: 1, userId: 'u1', partName: 'радиатор', ...ticket };
  const prisma = {
    sourcingTicket: {
      findMany: jest.fn(async () => [] as any[]),
      findUnique: jest.fn(async () => row),
      update: jest.fn(async () => row),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    sourcingOffer: {
      findMany: jest.fn(async () => [] as any[]),
      updateMany: jest.fn(async () => ({ count: 1 })),
      count: jest.fn(async () => 0),
    },
    sourcingRequest: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    appUser: { findUnique: jest.fn(async () => ({ language: 'RU' })) },
  };
  const telegram = {
    sendSourcingTicketToDealers: jest.fn(async () => ({ ok: true })),
    sendSourcingEscalation: jest.fn(async () => ({ ok: true })),
    escalationConfigured: true,
  };
  const adminEvents = { notifyAdminsTicketEscalated: jest.fn() };
  const notifications = { emit: jest.fn(async () => ({ id: 'n1' })) };
  const offers = { deliverOfferNotification: jest.fn(async () => undefined) };
  const config = {
    staffNotifyMaxAttempts: 3,
    escalateAfterMs: 1_800_000,
    noOfferAfterMs: 172_800_000,
  };
  const service = new SourcingLifecycleService(
    prisma as never,
    config as never,
    telegram as never,
    adminEvents as never,
    notifications as never,
    offers as never,
  );
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  return { service, prisma, telegram, adminEvents, notifications, offers };
}

describe('staff notification retries', () => {
  it('marks a delivered ticket as sent', async () => {
    const { service, prisma } = build();
    await service.dispatchStaffNotification('t1');
    expect(prisma.sourcingTicket.update.mock.calls[0]).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ staffNotifyStatus: 'SENT', staffNotifyError: null }),
      }),
    ]);
  });

  it('schedules a retry with the error when Telegram fails', async () => {
    const { service, prisma, telegram } = build();
    telegram.sendSourcingTicketToDealers.mockResolvedValue({ ok: false, error: '429' } as never);
    await service.dispatchStaffNotification('t1');
    const { data } = (prisma.sourcingTicket.update.mock.calls[0] as any)[0];
    expect(data.staffNotifyError).toBe('429');
    expect(data.staffNotifyStatus).toBeUndefined();
    expect(data.staffNotifyNextAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('marks it failed once attempts run out', async () => {
    const { service, prisma, telegram } = build({ staffNotifyAttempts: 3 });
    telegram.sendSourcingTicketToDealers.mockResolvedValue({ ok: false, error: 'down' } as never);
    await service.dispatchStaffNotification('t1');
    expect((prisma.sourcingTicket.update.mock.calls[0] as any)[0].data).toMatchObject({
      staffNotifyStatus: 'FAILED',
      staffNotifyNextAt: null,
    });
  });

  it('does not send when another run already claimed it', async () => {
    const { service, prisma, telegram } = build();
    prisma.sourcingTicket.updateMany.mockResolvedValue({ count: 0 });
    await service.dispatchStaffNotification('t1');
    expect(telegram.sendSourcingTicketToDealers).not.toHaveBeenCalled();
  });
});

describe('tickets and offers from before this release', () => {
  it('every sweep query is limited to rows the new flow created', async () => {
    const { service, prisma } = build();
    await service.sweep();

    const ticketQueries = prisma.sourcingTicket.findMany.mock.calls.map((c: any) => c[0].where);
    expect(ticketQueries).toEqual([
      expect.objectContaining({ staffNotifyStatus: 'PENDING' }),
      expect.objectContaining({ requestId: { not: null } }),
      expect.objectContaining({ customerNotice: { not: null } }),
    ]);
    expect((prisma.sourcingTicket.updateMany.mock.calls[0] as any)[0].where.requestId).toEqual({
      not: null,
    });
    const offerQueries = prisma.sourcingOffer.findMany.mock.calls.map((c: any) => c[0].where);
    expect(offerQueries).toEqual([
      expect.objectContaining({ expiresAt: { lte: expect.any(Date) } }),
      expect.objectContaining({ customerNotifyPending: true }),
    ]);
  });
});

describe('sweep', () => {
  it('one failing step does not stop the others', async () => {
    const { service, prisma, offers } = build();
    prisma.sourcingTicket.updateMany.mockRejectedValueOnce(new Error('db hiccup'));
    prisma.sourcingOffer.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'o1' }]);
    await expect(service.sweep()).resolves.toBeUndefined();
    expect(offers.deliverOfferNotification).toHaveBeenCalledWith('o1');
  });

  it('does not overlap itself', async () => {
    const { service, prisma } = build();
    await Promise.all([service.sweep(), service.sweep()]);
    expect(prisma.sourcingRequest.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('escalation', () => {
  it('alerts staff once, recording it', async () => {
    const { service, prisma, telegram, adminEvents } = build();
    prisma.sourcingTicket.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 't1', status: 'PENDING' }]);
    await service.sweep();
    expect(telegram.sendSourcingEscalation).toHaveBeenCalledTimes(1);
    expect(adminEvents.notifyAdminsTicketEscalated).toHaveBeenCalledTimes(1);
    expect(prisma.sourcingTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { escalatedAt: expect.any(Date) } }),
    );
  });

  it('tries again next time if the send failed', async () => {
    const { service, prisma, telegram } = build();
    telegram.sendSourcingEscalation.mockResolvedValue({ ok: false, error: 'x' } as never);
    prisma.sourcingTicket.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 't1', status: 'PENDING' }]);
    await service.sweep();
    expect(prisma.sourcingTicket.update).not.toHaveBeenCalled();
  });
});

describe('no-offer outcome', () => {
  it('only closes open tickets with no offers, and tells the customer', async () => {
    const { service, prisma } = build();
    await service.sweep();
    expect((prisma.sourcingTicket.updateMany.mock.calls[0] as any)[0]).toMatchObject({
      where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, offers: { none: {} } },
      data: { status: 'NO_OFFER', customerNotice: 'NO_OFFER' },
    });
  });
});

describe('offer expiry', () => {
  const expiring = (prisma: any) =>
    prisma.sourcingOffer.findMany.mockResolvedValueOnce([{ id: 'o1', ticketId: 't1' }]);

  it('ends the ticket when its last live offer expires', async () => {
    const { service, prisma } = build();
    expiring(prisma);
    await service.sweep();
    expect(prisma.sourcingOffer.updateMany.mock.calls[0]).toEqual([
      expect.objectContaining({
        data: { status: 'EXPIRED', customerNotifyPending: false },
      }),
    ]);
    expect(prisma.sourcingTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'NO_OFFER', customerNotice: 'OFFERS_EXPIRED' },
      }),
    );
  });

  it('leaves the ticket alone while another offer is still live', async () => {
    const { service, prisma } = build();
    expiring(prisma);
    prisma.sourcingOffer.count.mockResolvedValue(1);
    await service.sweep();
    expect(prisma.sourcingTicket.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ customerNotice: 'OFFERS_EXPIRED' }) }),
    );
  });
});

describe('customer status updates', () => {
  const noticed = (prisma: any) =>
    prisma.sourcingTicket.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 't1', userId: 'u1', partName: 'радиатор', customerNotice: 'NO_OFFER' },
      ]);

  it('sends an in-app notice in the customer language', async () => {
    const { service, prisma, notifications } = build();
    noticed(prisma);
    prisma.appUser.findUnique.mockResolvedValue({ language: 'UZ' });
    await service.sweep();
    expect(notifications.emit).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        type: 'SOURCING_STATUS',
        title: 'Takliflar yoʻq',
        body: expect.stringContaining('радиатор'),
      }),
    );
  });

  it('restores the notice if delivery fails, so it retries', async () => {
    const { service, prisma, notifications } = build();
    noticed(prisma);
    notifications.emit.mockRejectedValue(new Error('down'));
    await service.sweep();
    expect(prisma.sourcingTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { customerNotice: 'NO_OFFER' } }),
    );
  });
});
