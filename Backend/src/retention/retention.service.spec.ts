// LOW-ING-009. One fake lock shared by "instances", released with its transaction as
// Postgres does. Says nothing about a real server or PgBouncer.
import { RetentionService } from './retention.service';

function cluster() {
  let held = false;
  const statements: string[] = [];
  const instance = () => {
    const refreshToken = {
      findMany: jest.fn(async () => [] as { id: number }[]),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    };
    const emailVerificationToken = {
      findMany: jest.fn(async () => [] as { id: number }[]),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    };
    const prisma = {
      // Deletes outside the transaction would fail here.
      refreshToken: undefined,
      emailVerificationToken: undefined,
      $queryRaw: jest.fn(async () => {
        throw new Error('the lock must not be taken outside the transaction');
      }),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        let mine = false;
        const tx = {
          refreshToken,
          emailVerificationToken,
          $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
            statements.push(parts.join('?'));
            if (held) return [{ locked: false }];
            held = true;
            mine = true;
            return [{ locked: true }];
          }),
        };
        try {
          return await fn(tx);
        } finally {
          if (mine) held = false;
        }
      }),
    };
    const service = new RetentionService(prisma as never, { get: () => undefined } as never);
    jest.spyOn((service as any).logger, 'log').mockImplementation();
    jest.spyOn((service as any).logger, 'error').mockImplementation();
    return { prisma, service, refreshToken, emailVerificationToken };
  };
  return { instance, statements, isHeld: () => held };
}

describe('retention lock (LOW-ING-009)', () => {
  it('takes a transaction-scoped lock', async () => {
    const { instance, statements } = cluster();
    await instance().service.handleRetention();
    expect(statements[0]).toContain('pg_try_advisory_xact_lock');
  });

  it('of two concurrent runs only one does the work', async () => {
    const c = cluster();
    const a = c.instance();
    const b = c.instance();
    await Promise.all([a.service.handleRetention(), b.service.handleRetention()]);
    const worked = [a, b].filter((x) => x.refreshToken.findMany.mock.calls.length > 0);
    expect(worked).toHaveLength(1);
  });

  it('the lock is gone when the transaction ends, so the next run proceeds', async () => {
    const c = cluster();
    const a = c.instance();
    await a.service.handleRetention();
    expect(c.isHeld()).toBe(false);
    await a.service.handleRetention();
    expect(a.refreshToken.findMany).toHaveBeenCalledTimes(2);
  });

  it('a failure neither pins the lock nor escapes the cron handler', async () => {
    const c = cluster();
    const a = c.instance();
    a.refreshToken.findMany.mockRejectedValueOnce(new Error('boom'));
    await expect(a.service.handleRetention()).resolves.toBeUndefined();
    expect(c.isHeld()).toBe(false);
    await a.service.handleRetention();
    expect(a.emailVerificationToken.findMany).toHaveBeenCalledTimes(1);
  });

  it('gives the transaction room to outlast the batches', async () => {
    const c = cluster();
    const a = c.instance();
    await a.service.handleRetention();
    expect((a.prisma.$transaction.mock.calls[0] as any[])[1].timeout).toBeGreaterThan(60_000);
  });
});
