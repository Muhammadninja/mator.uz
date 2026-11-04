import { Prisma } from '@prisma/client';
import { SourcingRequestService, sourcingPayloadHash } from './sourcing-request.service';
import { SourcingLeaseLostError } from './sourcing-request.service';

/** Just enough of the table: the unique constraint and guarded updates are what count. */
function fakePrisma() {
  const rows: any[] = [];
  const tickets: any[] = [];
  const unique = (userId: string, key: string) =>
    rows.find((r) => r.userId === userId && r.idempotencyKey === key);
  const matches = (row: any, where: any) =>
    (!where.id || row.id === where.id) &&
    (!where.status || row.status === where.status) &&
    (!('leaseToken' in where) || row.leaseToken === where.leaseToken) &&
    (!where.leaseExpiresAt || row.leaseExpiresAt <= where.leaseExpiresAt.lte);
  const sourcingRequest = {
    create: jest.fn(async ({ data }: any) => {
      if (unique(data.userId, data.idempotencyKey)) {
        throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
      }
      const row = { id: `req_${rows.length + 1}`, status: 'PROCESSING', response: null, ...data };
      rows.push(row);
      return row;
    }),
    findUnique: jest.fn(async ({ where }: any) => {
      const { userId, idempotencyKey } = where.userId_idempotencyKey;
      return unique(userId, idempotencyKey) ?? null;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { count: hit.length };
    }),
  };
  const sourcingTicket = {
    create: jest.fn(async ({ data }: any) => {
      tickets.push(data);
      return data;
    }),
  };
  const tx = { sourcingRequest, sourcingTicket };
  return { ...tx, rows, tickets, $transaction: jest.fn((fn: any) => fn(tx)) };
}

const config = { idempotencyLeaseMs: 60_000, idempotencyWaitMs: 2_000 };
const claimInput = {
  userId: 'user-1',
  idempotencyKey: 'key-00000001',
  payloadHash: 'hash-a',
  vehicleId: 'v1',
};
const item = {
  id: 't1',
  partName: 'радиатор',
  partKey: 'радиатор',
  vehicleKey: 'vehicle:v1',
  vehicleId: 'v1',
  extractedData: {},
};
const commitInput = (claim: any) => ({
  claim,
  userId: 'user-1',
  payloadHash: 'hash-a',
  vehicleId: 'v1',
  rawMessage: 'нужен радиатор',
  items: [item],
  response: { ticket_id: 't1' },
});

function build() {
  const prisma = fakePrisma();
  return { prisma, service: new SourcingRequestService(prisma as never, config as never) };
}

describe('SourcingRequestService', () => {
  it('concurrent retries: one runs, and the other gets its result', async () => {
    const { service, prisma } = build();
    const owner: any = await service.claim(claimInput);
    expect(owner.kind).toBe('owner');

    const retry = service.claim(claimInput);
    await service.commit(commitInput(owner));

    await expect(retry).resolves.toEqual({ kind: 'replay', response: { ticket_id: 't1' } });
    expect(prisma.tickets).toHaveLength(1);
  });

  it('a later retry returns the original result without creating anything', async () => {
    const { service, prisma } = build();
    await service.commit(commitInput(await service.claim(claimInput)));
    await expect(service.claim(claimInput)).resolves.toMatchObject({ kind: 'replay' });
    expect(prisma.tickets).toHaveLength(1);
  });

  it('rejects the same key with a different message or car', async () => {
    const { service } = build();
    await service.claim(claimInput);
    await expect(service.claim({ ...claimInput, payloadHash: 'hash-b' })).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  it('never shares a key across accounts', async () => {
    const { service } = build();
    const first: any = await service.claim(claimInput);
    const second: any = await service.claim({ ...claimInput, userId: 'user-2' });
    expect(second.kind).toBe('owner');
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('stops waiting with a clear error if the first attempt runs too long', async () => {
    const { service } = build();
    await service.claim(claimInput);
    await expect(service.claim(claimInput)).rejects.toMatchObject({
      response: { code: 'REQUEST_IN_PROGRESS' },
    });
  });

  it('takes over after the first attempt dies, and the dead one cannot commit', async () => {
    const { service, prisma } = build();
    const dead: any = await service.claim(claimInput);
    prisma.rows[0].leaseExpiresAt = new Date(Date.now() - 1000);

    const takeover: any = await service.claim(claimInput);
    expect(takeover.kind).toBe('owner');
    expect(takeover.leaseToken).not.toBe(dead.leaseToken);

    await expect(service.commit(commitInput(dead))).rejects.toBeInstanceOf(SourcingLeaseLostError);
    expect(prisma.tickets).toHaveLength(0);
    await service.commit(commitInput(takeover));
    expect(prisma.tickets).toHaveLength(1);
  });

  it('after a release, the same key can run again', async () => {
    const { service } = build();
    const claim: any = await service.claim(claimInput);
    await service.release(claim);
    await expect(service.claim(claimInput)).resolves.toMatchObject({ kind: 'owner' });
  });

  it('marks new tickets as owing a staff notification', async () => {
    const { service, prisma } = build();
    await service.commit(commitInput(await service.claim(claimInput)));
    expect(prisma.tickets[0]).toMatchObject({
      userId: 'user-1',
      staffNotifyStatus: 'PENDING',
      requestId: 'req_1',
    });
  });

  it('still groups items for an app that sends no request id', async () => {
    const { service, prisma } = build();
    await service.commit(commitInput(null));
    expect(prisma.rows[0].idempotencyKey).toMatch(/^auto:/);
    expect(prisma.rows[0].status).toBe('COMPLETED');
  });
});

describe('sourcingPayloadHash', () => {
  it('differs by message and by car, not by surrounding space', () => {
    const base = sourcingPayloadHash('радиатор', 'v1');
    expect(sourcingPayloadHash(' радиатор ', 'v1')).toBe(base);
    expect(sourcingPayloadHash('фильтр', 'v1')).not.toBe(base);
    expect(sourcingPayloadHash('радиатор', 'v2')).not.toBe(base);
  });
});
