import { VehicleImageOutboxStatus, VehicleImageStatus } from '@prisma/client';
import { canonicalIdentityKey } from './vehicle-image.identity';
import {
  MAX_DISPATCH_ATTEMPTS,
  VehicleImageDeliveryService,
} from './vehicle-image.delivery.service';
import { PipelineCallError } from './vehicle-image.pipeline-client';

const IDENTITY = {
  makeId: 'byd',
  modelId: 'byd-han',
  modelYear: 2024,
  generationId: null,
  faceliftId: null,
  bodyType: null,
  trimId: null,
};
const KEY = canonicalIdentityKey(IDENTITY);
const identityRow = (over = {}) => ({
  identityKey: KEY,
  identity: IDENTITY,
  display: { manufacturer: 'BYD', model: 'Han' },
  status: VehicleImageStatus.PENDING,
  reason: null,
  pipelineStatus: null,
  pipelineRequestId: null,
  imageUrl: null,
  imageVersion: null,
  lastSyncedAt: null,
  nextSyncAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function setup() {
  const prisma: any = {
    vehicleImageOutbox: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'vio_1',
        identityKey: KEY,
        attempts: 1,
        identity: identityRow(),
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    vehicleImageIdentity: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const client = {
    enabled: true,
    defaultTimeoutMs: 10_000,
    request: jest.fn(),
    resolve: jest.fn(),
  };
  const queue = { addBulk: jest.fn().mockResolvedValue([]) };
  const svc = new VehicleImageDeliveryService(
    prisma,
    client as any,
    queue as any,
  );
  return { svc, prisma, client, queue };
}

describe('VehicleImageDeliveryService.dispatch', () => {
  it('claims only the attempt the job carries', async () => {
    const { svc, prisma, client } = setup();
    prisma.vehicleImageOutbox.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await svc.dispatch({ outboxId: 'vio_1', attempt: 0 })).toBe(
      'skipped',
    );
    expect(prisma.vehicleImageOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'vio_1',
        status: VehicleImageOutboxStatus.PENDING,
        attempts: 0,
      },
      data: { attempts: 1, availableAt: expect.any(Date) },
    });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('on success marks the row dispatched and stores the pipeline state', async () => {
    const { svc, prisma, client } = setup();
    client.request.mockResolvedValue({
      identityKey: KEY,
      status: 'queued',
      requestId: 'r-1',
      asset: null,
    });
    expect(await svc.dispatch({ outboxId: 'vio_1', attempt: 0 })).toBe(
      'dispatched',
    );
    expect(client.request).toHaveBeenCalledWith(IDENTITY, {
      manufacturer: 'BYD',
      model: 'Han',
    });
    expect(prisma.vehicleImageOutbox.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'vio_1',
        status: VehicleImageOutboxStatus.PENDING,
        attempts: 1,
      },
      data: {
        status: VehicleImageOutboxStatus.DISPATCHED,
        dispatchedAt: expect.any(Date),
        lastError: null,
      },
    });
    expect(prisma.vehicleImageIdentity.update).toHaveBeenCalledWith({
      where: { identityKey: KEY },
      data: expect.objectContaining({
        status: VehicleImageStatus.PENDING,
        pipelineStatus: 'queued',
        pipelineRequestId: 'r-1',
        lastSyncedAt: expect.any(Date),
      }),
    });
  });

  it('an outage schedules a retry with backoff', async () => {
    const { svc, prisma, client } = setup();
    client.request.mockRejectedValue(new PipelineCallError('timeout', true));
    expect(await svc.dispatch({ outboxId: 'vio_1', attempt: 0 })).toBe(
      'retry_scheduled',
    );
    const last = prisma.vehicleImageOutbox.updateMany.mock.calls.at(-1)[0];
    expect(last.data.lastError).toBe('timeout');
    expect(last.data.availableAt.getTime()).toBeGreaterThan(
      Date.now() + 20_000,
    );
    // Only the error is recorded on the identity; its state is untouched.
    expect(prisma.vehicleImageIdentity.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.vehicleImageIdentity.updateMany).toHaveBeenCalledWith({
      where: { identityKey: KEY },
      data: { lastError: 'timeout', lastErrorAt: expect.any(Date) },
    });
  });

  it('after the last attempt, or on a permanent refusal, the row is dead and the identity unavailable', async () => {
    for (const [err, attempt] of [
      [new PipelineCallError('http_503', true), MAX_DISPATCH_ATTEMPTS - 1],
      [new PipelineCallError('pipeline_rejected_request', false), 0],
    ] as const) {
      const { svc, prisma, client } = setup();
      client.request.mockRejectedValue(err);
      expect(await svc.dispatch({ outboxId: 'vio_1', attempt })).toBe('dead');
      expect(prisma.vehicleImageOutbox.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'vio_1',
          status: VehicleImageOutboxStatus.PENDING,
          attempts: attempt + 1,
        },
        data: { status: VehicleImageOutboxStatus.DEAD, lastError: err.code },
      });
      expect(prisma.vehicleImageIdentity.updateMany).toHaveBeenCalledWith({
        where: {
          identityKey: KEY,
          status: VehicleImageStatus.PENDING,
          lastSyncedAt: null,
        },
        data: {
          status: VehicleImageStatus.UNAVAILABLE,
          reason: 'dispatch_failed',
          nextSyncAt: null,
        },
      });
    }
  });

  it('a tampered stored identity is never sent', async () => {
    const { svc, prisma, client } = setup();
    prisma.vehicleImageOutbox.findUnique.mockResolvedValue({
      id: 'vio_1',
      identityKey: KEY,
      attempts: 1,
      identity: identityRow({ identity: { ...IDENTITY, modelYear: 2025 } }),
    });
    expect(await svc.dispatch({ outboxId: 'vio_1', attempt: 0 })).toBe('dead');
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('VehicleImageDeliveryService relay / sync / refresh', () => {
  it('relay queues due rows by attempt and dead-letters exhausted ones', async () => {
    const { svc, prisma, queue } = setup();
    prisma.vehicleImageOutbox.findMany.mockResolvedValue([
      { id: 'vio_1', attempts: 0, identityKey: KEY },
      { id: 'vio_2', attempts: 3, identityKey: KEY },
      { id: 'vio_3', attempts: MAX_DISPATCH_ATTEMPTS, identityKey: KEY },
    ]);
    expect(await svc.relayDue()).toBe(2);
    expect(
      queue.addBulk.mock.calls[0][0].map((j: any) => j.opts.jobId),
    ).toEqual(['vio_1-a0', 'vio_2-a3']);
    expect(prisma.vehicleImageOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'vio_3' }),
        data: expect.objectContaining({ status: 'DEAD' }),
      }),
    );
  });

  it('sync reads acknowledged identities and stops the batch on an outage', async () => {
    const { svc, prisma, client } = setup();
    const due = new Date(Date.now() - 1000);
    prisma.vehicleImageIdentity.findMany.mockResolvedValue([
      identityRow({ lastSyncedAt: due, nextSyncAt: due }),
      identityRow({ lastSyncedAt: due, nextSyncAt: due }),
    ]);
    client.resolve
      .mockResolvedValueOnce({
        identityKey: KEY,
        status: 'approved',
        requestId: 'r',
        asset: { url: 'https://cdn.test/a.webp', version: 1 },
      })
      .mockRejectedValueOnce(new PipelineCallError('network', true));
    expect(await svc.syncDue()).toBe(1);
    expect(prisma.vehicleImageIdentity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          nextSyncAt: { lte: expect.any(Date) },
          lastSyncedAt: { not: null },
        },
      }),
    );
    expect(prisma.vehicleImageIdentity.update).toHaveBeenCalledWith({
      where: { identityKey: KEY },
      data: expect.objectContaining({
        status: VehicleImageStatus.APPROVED,
        imageUrl: 'https://cdn.test/a.webp',
        imageVersion: 1,
      }),
    });
  });

  it('refresh is throttled per identity and never throws', async () => {
    const { svc, prisma, client } = setup();
    prisma.vehicleImageIdentity.findUnique.mockResolvedValue(
      identityRow({ lastSyncedAt: new Date() }),
    );
    await svc.refresh(KEY);
    expect(client.resolve).not.toHaveBeenCalled();

    prisma.vehicleImageIdentity.findUnique.mockResolvedValue(
      identityRow({ lastSyncedAt: new Date(Date.now() - 60_000) }),
    );
    client.resolve.mockRejectedValue(new PipelineCallError('timeout', true));
    await expect(svc.refresh(KEY)).resolves.toBeUndefined();
    expect(client.resolve).toHaveBeenCalledWith(IDENTITY, 3000);

    prisma.vehicleImageIdentity.findUnique.mockRejectedValue(new Error('db'));
    await expect(svc.refresh(KEY)).resolves.toBeUndefined();
  });

  it('refresh does nothing before the pipeline acknowledged the request', async () => {
    const { svc, prisma, client } = setup();
    prisma.vehicleImageIdentity.findUnique.mockResolvedValue(
      identityRow({ lastSyncedAt: null }),
    );
    await svc.refresh(KEY);
    expect(client.resolve).not.toHaveBeenCalled();
    expect(prisma.vehicleImageIdentity.updateMany).not.toHaveBeenCalled();
  });
});

describe('VehicleImageDeliveryService recovery', () => {
  const ready = { ready: true, registryMatches: true, registrySha256: 'x', contract: 2, capabilities: null };

  function recovery(health: Record<string, unknown> = ready) {
    const ctx = setup();
    (ctx.client as any).health = jest.fn().mockResolvedValue(health);
    ctx.prisma.vehicleImageOutbox.createMany = jest.fn().mockResolvedValue({ count: 1 });
    return ctx;
  }

  it('asks nothing while the pipeline is down or on another registry', async () => {
    for (const health of [{ ...ready, ready: false, error: 'network:ECONNREFUSED' }, { ...ready, registryMatches: false }]) {
      const { svc, prisma, queue } = recovery(health);
      expect(await svc.reviveStalled()).toBe(0);
      expect(prisma.vehicleImageIdentity.findMany).not.toHaveBeenCalled();
      expect(queue.addBulk).not.toHaveBeenCalled();
    }
  });

  it('re-requests identities that never reached the pipeline and a live vehicle still shows', async () => {
    const { svc, prisma, queue } = recovery();
    const now = new Date('2026-11-14T12:00:00Z');
    prisma.vehicleImageIdentity.findMany.mockResolvedValue([
      { identityKey: KEY, reason: 'dispatch_failed' },
    ]);
    expect(await svc.reviveStalled(now)).toBe(1);
    const query = prisma.vehicleImageIdentity.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({
      status: VehicleImageStatus.UNAVAILABLE,
      reason: { in: expect.arrayContaining(['dispatch_failed', 'request_missing', 'not_requested']) },
      vehicles: { some: { deletedAt: null } },
      outbox: { none: { status: VehicleImageOutboxStatus.PENDING } },
    });
    expect(query.where.reason.in).not.toContain('generation_failed');
    expect(query.where.reason.in).not.toContain('rejected');
    expect(query.where.updatedAt.lt.getTime()).toBe(now.getTime() - 30 * 60_000);
    expect(prisma.vehicleImageIdentity.updateMany).toHaveBeenCalledWith({
      where: { identityKey: KEY, status: VehicleImageStatus.UNAVAILABLE, reason: 'dispatch_failed' },
      data: expect.objectContaining({ status: VehicleImageStatus.PENDING, reason: null, lastSyncedAt: null }),
    });
    expect(prisma.vehicleImageOutbox.createMany).toHaveBeenCalledWith({
      data: [{ id: expect.stringMatching(/./), identityKey: KEY, availableAt: now }],
      skipDuplicates: true,
    });
    expect(queue.addBulk).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'dispatch', data: { outboxId: expect.any(String), attempt: 0 } }),
    ]);
  });

  it('skips an identity that changed meanwhile', async () => {
    const { svc, prisma, queue } = recovery();
    prisma.vehicleImageIdentity.findMany.mockResolvedValue([{ identityKey: KEY, reason: 'request_missing' }]);
    prisma.vehicleImageIdentity.updateMany.mockResolvedValue({ count: 0 });
    expect(await svc.reviveStalled()).toBe(0);
    expect(prisma.vehicleImageOutbox.createMany).not.toHaveBeenCalled();
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  it('syncNow re-reads one identity, applies it and clears the last error', async () => {
    const { svc, prisma, client } = recovery();
    prisma.vehicleImageIdentity.findUnique.mockResolvedValue(identityRow({ lastSyncedAt: new Date() }));
    client.resolve.mockResolvedValue({ identityKey: KEY, status: 'awaiting_approval', requestId: 'r-1', asset: null });
    expect(await svc.syncNow(KEY)).toBe(true);
    expect(prisma.vehicleImageIdentity.update).toHaveBeenCalledWith({
      where: { identityKey: KEY },
      data: expect.objectContaining({ pipelineStatus: 'awaiting_approval', lastError: null, lastErrorAt: null }),
    });
    client.resolve.mockRejectedValue(new PipelineCallError('registry_mismatch', true));
    expect(await svc.syncNow(KEY)).toBe(false);
    expect(prisma.vehicleImageIdentity.updateMany).toHaveBeenLastCalledWith({
      where: { identityKey: KEY },
      data: { lastError: 'registry_mismatch', lastErrorAt: expect.any(Date) },
    });
  });
});
