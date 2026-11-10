// LOW-PLT-010: a push token belongs to one account at a time, and signing out
// of a device stops notifications to it. Runs against an in-memory `devices`
// table that implements the two Prisma calls the code uses.

import { DevicesService } from './devices.service';
import { PushDispatchService } from './push/push-dispatch.service';
import { TokenService } from '../auth/tokens/token.service';

interface Row {
  id: string;
  userId: string;
  installId: string;
  expoPushToken: string | null;
  fcmToken: string | null;
  apnsToken: string | null;
  [key: string]: unknown;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') {
      return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    }
    if (cond && typeof cond === 'object') {
      const c = cond as { not?: unknown; in?: unknown[] };
      if ('not' in c) return row[key] !== c.not;
      if ('in' in c) return c.in!.includes(row[key]);
    }
    return row[key] === cond;
  });
}

function fakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  const device = {
    upsert: jest.fn(
      async (args: {
        where: { userId_installId: { userId: string; installId: string } };
        create: Row;
        update: Partial<Row>;
      }) => {
        const key = args.where.userId_installId;
        let row = rows.find(
          (r) => r.userId === key.userId && r.installId === key.installId,
        );
        if (row) Object.assign(row, args.update);
        else {
          row = {
            ...args.create,
            id: args.create.id ?? `dev_${++seq}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          rows.push(row);
        }
        return { ...row };
      },
    ),
    updateMany: jest.fn(
      async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, args.where));
        hit.forEach((r) => Object.assign(r, args.data));
        return { count: hit.length };
      },
    ),
    findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
      rows.filter((r) => matches(r, args.where)).map((r) => ({ ...r })),
    ),
  };
  const refreshRows: {
    tokenHash: string;
    userId: string;
    deviceId: string | null;
  }[] = [];
  const refreshToken = {
    findUnique: jest.fn(
      async (a: { where: { tokenHash: string } }) =>
        refreshRows.find((r) => r.tokenHash === a.where.tokenHash) ?? null,
    ),
    deleteMany: jest.fn(
      async (a: { where: { tokenHash?: string; userId?: string } }) => {
        const before = refreshRows.length;
        for (let i = refreshRows.length - 1; i >= 0; i--) {
          const r = refreshRows[i];
          if (
            (a.where.tokenHash && r.tokenHash === a.where.tokenHash) ||
            (a.where.userId && r.userId === a.where.userId)
          ) {
            refreshRows.splice(i, 1);
          }
        }
        return { count: before - refreshRows.length };
      },
    ),
  };
  const prisma = {
    device,
    refreshToken,
    appUser: { update: jest.fn().mockResolvedValue({ tokenVersion: 1 }) },
    $transaction: (run: (tx: unknown) => unknown) => run(prisma),
  };
  return { prisma, rows, refreshRows };
}

const reg = (install: string, token: string | null) => ({
  install_id: install,
  platform: 'ios',
  expo_push_token: token ?? undefined,
});

describe('push token ownership', () => {
  let db: ReturnType<typeof fakeDb>;
  let devices: DevicesService;
  let tokens: TokenService;
  let expo: { send: jest.Mock };
  let push: PushDispatchService;
  const sentTo = () =>
    (expo.send.mock.calls.at(-1)![0] as { token: string }[]).map(
      (m) => m.token,
    );

  beforeEach(() => {
    db = fakeDb();
    devices = new DevicesService(db.prisma as never);
    tokens = new TokenService(
      db.prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expo = { send: jest.fn().mockResolvedValue([]) };
    const none = { send: jest.fn().mockResolvedValue([]) };
    push = new PushDispatchService(
      db.prisma as never,
      expo as never,
      none as never,
      none as never,
    );
  });

  it('a second account signing in on the same phone takes the token; the first stops receiving', async () => {
    await devices.register('alice', reg('phone-1', 'ExpoToken[A]') as never);
    await devices.register('bob', reg('phone-1', 'ExpoToken[A]') as never);

    const holders = db.rows.filter((r) => r.expoPushToken === 'ExpoToken[A]');
    expect(holders.map((r) => r.userId)).toEqual(['bob']);

    await push.sendToUser('alice', { title: 't', body: 'b' });
    expect(sentTo()).toEqual([]);
    await push.sendToUser('bob', { title: 't', body: 'b' });
    expect(sentTo()).toEqual(['ExpoToken[A]']);
  });

  it('re-registration by the same account and install is idempotent', async () => {
    await devices.register('alice', reg('phone-1', 'ExpoToken[A]') as never);
    await devices.register('alice', reg('phone-1', 'ExpoToken[A]') as never);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].expoPushToken).toBe('ExpoToken[A]');
  });

  it('logout releases only the signed-out device; other devices keep notifications', async () => {
    await devices.register('alice', reg('phone-1', 'ExpoToken[A]') as never);
    await devices.register('alice', reg('tablet-1', 'ExpoToken[B]') as never);

    await tokens.logoutDevice('alice', 'rt_unknown', 'phone-1');

    await push.sendToUser('alice', { title: 't', body: 'b' });
    expect(sentTo()).toEqual(['ExpoToken[B]']);
    // The device row and its registration survive; only the token is gone.
    expect(db.rows).toHaveLength(2);
  });

  it('logout finds the device through the session when no install id is sent', async () => {
    await devices.register('alice', reg('phone-1', 'ExpoToken[A]') as never);
    const hash = (tokens as unknown as { hash(t: string): string }).hash(
      'rt_1',
    );
    db.refreshRows.push({
      tokenHash: hash,
      userId: 'alice',
      deviceId: db.rows[0].id,
    });

    await tokens.logoutDevice('alice', 'rt_1');

    expect(db.rows[0].expoPushToken).toBeNull();
    expect(db.refreshRows).toHaveLength(0);
  });

  it("cannot silence another account's device with its install id or refresh token", async () => {
    await devices.register('alice', reg('phone-1', 'ExpoToken[A]') as never);
    const hash = (tokens as unknown as { hash(t: string): string }).hash(
      'rt_alice',
    );
    db.refreshRows.push({
      tokenHash: hash,
      userId: 'alice',
      deviceId: db.rows[0].id,
    });

    await tokens.logoutDevice('mallory', 'rt_alice', 'phone-1');

    expect(db.rows[0].expoPushToken).toBe('ExpoToken[A]');
  });

  it('logout-all releases every device of the account and nobody else', async () => {
    await devices.register('alice', reg('phone-1', 'ExpoToken[A]') as never);
    await devices.register('alice', reg('tablet-1', 'ExpoToken[B]') as never);
    await devices.register('bob', reg('phone-2', 'ExpoToken[C]') as never);

    await tokens.logoutAllDevices('alice');

    expect(
      db.rows.filter((r) => r.userId === 'alice').map((r) => r.expoPushToken),
    ).toEqual([null, null]);
    expect(db.rows.find((r) => r.userId === 'bob')!.expoPushToken).toBe(
      'ExpoToken[C]',
    );
  });

  it('sends one message per token even when legacy rows duplicate it', async () => {
    // Rows written before tokens were claimed can still share one.
    db.rows.push(
      {
        id: 'd1',
        userId: 'alice',
        installId: 'i1',
        expoPushToken: 'ExpoToken[A]',
        fcmToken: null,
        apnsToken: null,
      },
      {
        id: 'd2',
        userId: 'alice',
        installId: 'i2',
        expoPushToken: 'ExpoToken[A]',
        fcmToken: null,
        apnsToken: null,
      },
    );
    await push.sendToUser('alice', { title: 't', body: 'b' });
    expect(sentTo()).toEqual(['ExpoToken[A]']);
  });
});
