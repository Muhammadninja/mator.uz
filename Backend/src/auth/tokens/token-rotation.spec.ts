// LOW-PLT-007: of concurrent rotations of one refresh token, the database lets one
// through. A Map with an atomic updateMany stands in for the row, which shows the
// service's logic; the real row-level race is in test/integration/p1-concurrency.
import { UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';

const FUTURE = new Date(Date.now() + 3_600_000);

function world() {
  const rows = new Map<number, Record<string, any>>();
  const user = {
    id: 'u1',
    email: null,
    role: 'USER',
    tokenVersion: 3,
    deletedAt: null,
  };
  let nextId = 1;
  const add = (tokenHash: string, over: Record<string, unknown> = {}) => {
    const id = nextId++;
    rows.set(id, {
      id,
      tokenHash,
      userId: 'u1',
      deviceId: null,
      tokenVersion: 3,
      consumedAt: null,
      expiresAt: FUTURE,
      ...over,
    });
    return id;
  };
  const prisma = {
    refreshToken: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = where.id
          ? rows.get(where.id)
          : [...rows.values()].find((r) => r.tokenHash === where.tokenHash);
        return row ? { ...row, user } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row || row.consumedAt !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      delete: jest.fn(async ({ where }: any) => rows.delete(where.id)),
      deleteMany: jest.fn(async () => {
        const count = rows.size;
        rows.clear();
        return { count };
      }),
      create: jest.fn(async ({ data }: any) => {
        add(data.tokenHash, data);
        return data;
      }),
    },
    appUser: {
      update: jest.fn(async () => ({ tokenVersion: ++user.tokenVersion })),
    },
  };
  const service = new TokenService(
    prisma as never,
    { signAsync: jest.fn().mockResolvedValue('jwt') } as never,
    { privateKey: 'k', kid: 'kid' } as never,
    { get: () => undefined } as never,
    {} as never,
  );
  const hash = (raw: string) => (service as any).hash(raw) as string;
  return { service, prisma, rows, add, hash };
}

describe('TokenService.rotate — atomic reuse detection', () => {
  it('lets exactly one of two concurrent rotations through and treats the other as reuse', async () => {
    const { service, prisma, add, hash } = world();
    add(hash('rt_a'));

    const results = await Promise.allSettled([
      service.rotate('rt_a'),
      service.rotate('rt_a'),
    ]);

    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.message).toBe('Refresh token reuse detected');
    // Reuse handling: the family dropped and the session version bumped.
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalled();
    expect(prisma.appUser.update).toHaveBeenCalled();
  });

  it('claims only an unused token', async () => {
    const { service, prisma, add, hash } = world();
    const id = add(hash('rt_a'));
    await service.rotate('rt_a');
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id, consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('revokes the family when an already-consumed token is presented', async () => {
    const { service, prisma, add, hash } = world();
    add(hash('rt_a'), { consumedAt: new Date() });
    add(hash('rt_other'));
    await expect(service.rotate('rt_a')).rejects.toThrow(
      'Refresh token reuse detected',
    );
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
  });

  it('keeps rejecting an expired token, without a reuse signal', async () => {
    const { service, prisma, add, hash } = world();
    add(hash('rt_a'), { expiresAt: new Date(Date.now() - 1000) });
    await expect(service.rotate('rt_a')).rejects.toThrow(
      'Refresh token expired',
    );
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });

  it('refreshes independent sessions separately', async () => {
    const { service, prisma, add, hash } = world();
    add(hash('rt_a'));
    add(hash('rt_b'));
    await expect(service.rotate('rt_a')).resolves.toBeDefined();
    await expect(service.rotate('rt_b')).resolves.toBeDefined();
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });

  it('does not sign everyone out when a logout removed the row mid-rotation', async () => {
    const { service, prisma, rows, add, hash } = world();
    const id = add(hash('rt_a'));
    prisma.refreshToken.updateMany.mockImplementationOnce(async () => {
      rows.delete(id);
      return { count: 0 };
    });
    await expect(service.rotate('rt_a')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.rotate('rt_a')).rejects.toThrow(
      'Invalid refresh token',
    );
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });
});
