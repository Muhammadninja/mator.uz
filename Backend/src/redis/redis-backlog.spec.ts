// The cap on Redis commands the process has stopped waiting for. A bounded
// wait (withRedisTimeout) cannot cancel a command, so without the cap a long
// Redis outage would let unanswered commands — each holding its payload —
// pile up in ioredis's offline queue for as long as sellers keep tapping.

import { NotificationType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import {
  makeFakeLock,
  type TelegramServiceHarness,
} from '../telegram/draft-lock.test-util';
import { TelegramService } from '../telegram/telegram.service';
import { CacheService } from './cache.service';
import { DraftLock } from './draft-lock.service';
import {
  MAX_UNANSWERED_REDIS_COMMANDS as MAX,
  RedisBacklogError,
  RedisTimeoutError,
  RedisUnavailableError,
  assertRedisBacklogRoom,
  unansweredRedisCommands,
} from './redis-backlog';
import { withRedisTimeout } from './redis.service';

const flush = () => new Promise((r) => setImmediate(r));

/** Commands that stay pending until released — Redis not answering. */
function heldCommands<T>() {
  const pending: ((v: T) => void)[] = [];
  const issue = jest.fn(
    () => new Promise<T>((resolve) => pending.push(resolve)),
  );
  const releaseAll = async (value: T) => {
    for (const resolve of pending.splice(0)) resolve(value);
    await flush();
  };
  return { issue, pending, releaseAll };
}

/** Fill the backlog to the cap with commands given up on; returns a drain. */
async function fillBacklog() {
  const held = heldCommands<string>();
  await Promise.all(
    Array.from({ length: MAX - unansweredRedisCommands() }, () =>
      withRedisTimeout(held.issue(), 1, 'filler').catch(() => undefined),
    ),
  );
  expect(unansweredRedisCommands()).toBe(MAX);
  return () => held.releaseAll('OK');
}

afterEach(() => {
  // Every test drains what it held: nothing leaks into the next one.
  expect(unansweredRedisCommands()).toBe(0);
  jest.restoreAllMocks();
});

describe('the unanswered-command cap', () => {
  it('counts a command given up on until Redis finally answers it', async () => {
    const held = heldCommands<string>();
    await expect(
      withRedisTimeout(held.issue(), 5, 'GET k'),
    ).rejects.toBeInstanceOf(RedisTimeoutError);
    expect(unansweredRedisCommands()).toBe(1);
    await held.releaseAll('v');
    expect(unansweredRedisCommands()).toBe(0);
  });

  it('does not count a command answered in time', async () => {
    await withRedisTimeout(Promise.resolve('v'), 50, 'GET k');
    expect(unansweredRedisCommands()).toBe(0);
  });

  it('refuses one more command at the cap, before it is issued, and accepts again once drained', async () => {
    const drain = await fillBacklog();
    expect(() => assertRedisBacklogRoom('SET k')).toThrow(RedisBacklogError);
    expect(() => assertRedisBacklogRoom('SET k')).toThrow(
      `Redis SET k not sent: ${MAX} earlier commands are still unanswered`,
    );
    const refused = (() => {
      try {
        assertRedisBacklogRoom('x');
      } catch (err) {
        return err;
      }
    })();
    expect(refused).toBeInstanceOf(RedisUnavailableError);
    expect(refused).not.toBeInstanceOf(RedisTimeoutError);

    await drain();
    expect(() => assertRedisBacklogRoom('SET k')).not.toThrow();
  });
});

describe('callers at the cap fall back without issuing anything', () => {
  it('DraftLock fails open without a SET', async () => {
    const drain = await fillBacklog();
    const client = { set: jest.fn(), eval: jest.fn() };
    const lock = new DraftLock({ getClient: () => client } as never);
    jest
      .spyOn((lock as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const handle = await lock.acquire('lock:k');
    expect(handle).not.toBeNull(); // proceeds unguarded; the DB guard still applies
    await handle!.release();
    expect(client.set).not.toHaveBeenCalled();
    await drain();
  });

  it('CacheService misses without a GET and drops a write without a SETEX', async () => {
    const drain = await fillBacklog();
    const redis = { get: jest.fn(), setEx: jest.fn(), del: jest.fn() };
    const cache = new CacheService(redis as never);
    jest
      .spyOn((cache as any).logger, 'warn')
      .mockImplementation(() => undefined);

    expect(await cache.get('k')).toBeNull();
    await cache.set('k', 1, 60);
    await cache.delete('k');
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.setEx).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    await drain();
  });

  it('NotificationsService keeps the inbox row and does not enqueue the push', async () => {
    const drain = await fillBacklog();
    const enqueueNotification = jest.fn();
    const prisma = {
      notification: {
        create: jest.fn(({ data }: any) => Promise.resolve({ ...data })),
      },
      notificationPreference: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const svc = new NotificationsService(
      prisma as never,
      { enqueueNotification } as never,
    );
    const warn = jest
      .spyOn((svc as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const row = await svc.emit('user_1', {
      type: NotificationType.SOURCING_OFFER,
      title: 't',
      body: 'b',
    });
    expect(row.userId).toBe('user_1');
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('earlier commands are still unanswered'),
    );
    await drain();
  });

  it('TelegramService neither awaits nor issues image jobs, and leaves the rows for /start', async () => {
    const drain = await fillBacklog();
    const enqueueImage = jest.fn();
    const removeImageJob = jest.fn();
    const warn: string[] = [];
    const svc = Object.create(
      TelegramService.prototype,
    ) as TelegramServiceHarness;
    Object.assign(svc, {
      logger: {
        log() {},
        warn: (m: string) => warn.push(m),
        error() {},
        debug() {},
      },
      locks: makeFakeLock(),
      drafts: { setImageJobId: jest.fn() },
      queue: { enqueueImage, removeImageJob },
    });

    await expect(svc.enqueueImageJob('d1', 'i1')).rejects.toBeInstanceOf(
      RedisBacklogError,
    );
    svc.deferImageJob('d1', 'i2', 'enqueue');
    await svc.discardDraftJobs({
      id: 'd1',
      images: [{ jobId: 'j1' }, { jobId: 'j2' }],
    });

    expect(enqueueImage).not.toHaveBeenCalled();
    expect(removeImageJob).not.toHaveBeenCalled();
    expect(warn).toContainEqual(
      expect.stringContaining(
        'Image i2 (draft d1) left PROCESSING for the next /start',
      ),
    );
    await drain();
  });
});
