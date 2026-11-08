// Task 2 — Redis inside BullMQ holding up the seller bot.
//
// The cause, shown on the REAL bullmq + ioredis: with the connection options
// the app gives BullMQ (`maxRetriesPerRequest: null`, see queue.config.ts),
// `queue.add()` neither resolves nor rejects while Redis is down or hung — it
// waits for Redis to come back. Telegraf polls again only once every update of
// a batch is handled, so a bot handler awaiting it held up EVERY seller.
//
// Only local endpoints are used: a port nothing listens on (Redis down) and a
// local server that accepts and never answers (Redis hung). Nothing else is
// reached; no real Redis exists in this environment.

import { createServer, type Server, type Socket } from 'node:net';
import { Queue } from 'bullmq';
import { NotificationType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { RedisTimeoutError, withRedisTimeout } from '../redis/redis.service';
import {
  makeFakeLock,
  type TelegramServiceHarness,
} from './draft-lock.test-util';
import { TelegramService } from './telegram.service';

// ── The cause, on the real libraries ────────────────────────────────────────

/** A local TCP server that accepts connections and never answers. */
async function hungRedis(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A local port nothing listens on. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A Queue built with the options QueueModule gives BullMQ (queue.config.ts). */
function queueOn(port: number): Queue {
  const queue = new Queue('stall-probe', {
    connection: {
      host: '127.0.0.1',
      port,
      maxRetriesPerRequest: null,
      // Keep the test quiet and quick; the production strategy only waits longer.
      retryStrategy: () => 50,
    },
  });
  queue.on('error', () => undefined);
  return queue;
}

async function settledWithin<T>(
  p: Promise<T>,
  ms: number,
): Promise<'pending' | 'settled'> {
  return Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms)),
  ]);
}

describe('BullMQ while Redis is unavailable (real bullmq + ioredis, local endpoints)', () => {
  const queues: Queue[] = [];
  afterEach(() => {
    // queue.disconnect()/close() wait for Redis too — the very behaviour under
    // test — so the underlying ioredis client is closed directly.
    for (const q of queues.splice(0)) {
      (q as any).connection?._client?.disconnect?.(false);
    }
  });

  it.each([
    [
      'down (connection refused)',
      async () => ({
        port: await deadPort(),
        close: () => Promise.resolve(),
      }),
    ],
    ['hung (accepts, never answers)', hungRedis],
  ])(
    'queue.add() waits without limit while Redis is %s — and withRedisTimeout bounds it',
    async (_label, endpoint) => {
      const redis = await endpoint();
      try {
        const queue = queueOn(redis.port);
        queues.push(queue);

        const add = queue.add('probe', { n: 1 }, { jobId: 'probe_1' });
        // Neither resolved nor rejected: a caller awaiting this simply waits.
        expect(await settledWithin(add, 600)).toBe('pending');

        // The event loop is not blocked meanwhile — a timer runs on time.
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, 20));
        expect(Date.now() - t0).toBeLessThan(200);

        const bounded = withRedisTimeout(
          queue.add('probe', { n: 2 }, { jobId: 'probe_2' }),
          100,
          'probe add',
        );
        await expect(bounded).rejects.toBeInstanceOf(RedisTimeoutError);
        await expect(bounded).rejects.toThrow(
          'Redis probe add timed out after 100ms',
        );
        add.catch(() => undefined);
      } finally {
        await redis.close();
      }
    },
  );
});

// ── The bot's producer calls ────────────────────────────────────────────────

/** A call that stays pending until the test releases it. */
function heldCall<T>() {
  const pending: { resolve: (v: T) => void; reject: (e: unknown) => void }[] =
    [];
  const fn = jest.fn(
    () =>
      new Promise<T>((resolve, reject) => pending.push({ resolve, reject })),
  );
  return { fn, pending };
}

function botService(queue: Record<string, unknown>) {
  const logs: string[] = [];
  const svc = Object.create(
    TelegramService.prototype,
  ) as TelegramServiceHarness;
  const record = (level: string) => (m: unknown) =>
    logs.push(`${level} ${String(m)}`);
  Object.assign(svc, {
    logger: {
      log: record('log'),
      warn: record('warn'),
      error: record('error'),
      debug() {},
    },
    locks: makeFakeLock(),
    drafts: { setImageJobId: jest.fn().mockResolvedValue(undefined) },
    queue,
  });
  return { svc, logs };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('TelegramService producer calls with Redis not answering', () => {
  beforeEach(() => {
    jest.replaceProperty(TelegramService, 'QUEUE_TIMEOUT_MS', 40);
  });
  afterEach(() => jest.restoreAllMocks());

  it('gives up on an enqueue after QUEUE_TIMEOUT_MS, and records the job id once it lands', async () => {
    const add = heldCall<{ id: string }>();
    const { svc } = botService({ enqueueImage: add.fn });

    const t0 = Date.now();
    await expect(
      svc.enqueueImageJob('draft_1', 'img_1'),
    ).rejects.toBeInstanceOf(RedisTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(svc.drafts.setImageJobId).not.toHaveBeenCalled();
    // The lock is released: a retry is not shadowed by the stalled attempt.
    expect(svc.locks.held.size).toBe(0);

    add.pending[0].resolve({ id: 'image_draft_1_img_1' });
    await flush();
    expect(svc.drafts.setImageJobId).toHaveBeenCalledWith(
      'img_1',
      'image_draft_1_img_1',
    );
  });

  it('waits out one timeout for a whole draft, not one per image, and still queues every image', async () => {
    const add = heldCall<{ id: string }>();
    const { svc, logs } = botService({ reenqueueImage: add.fn });
    const draft = {
      id: 'draft_1',
      images: ['a', 'b', 'c'].map((id) => ({
        id,
        status: 'PROCESSING',
        processedUrl: null,
      })),
    };

    const t0 = Date.now();
    await svc.reenqueueStuckImages(draft);
    const took = Date.now() - t0;

    expect(took).toBeLessThan(TelegramService.QUEUE_TIMEOUT_MS * 2 + 200);
    // Every row was handed to the queue — b and c without waiting.
    expect(add.fn).toHaveBeenCalledTimes(3);
    expect(
      logs.filter((l) => l.startsWith('error Failed to re-enqueue')),
    ).toHaveLength(1);

    for (const [i, p] of add.pending.entries()) p.resolve({ id: `job_${i}` });
    await flush();
    expect(svc.drafts.setImageJobId.mock.calls).toEqual([
      ['a', 'job_0'],
      ['b', 'job_1'],
      ['c', 'job_2'],
    ]);
  });

  it('keeps going image by image when Redis answers with an error rather than not at all', async () => {
    const reenqueueImage = jest
      .fn()
      .mockRejectedValueOnce(
        new Error("READONLY You can't write against a read only replica."),
      )
      .mockResolvedValue({ id: 'job_ok' });
    const { svc } = botService({ reenqueueImage });
    await svc.reenqueueStuckImages({
      id: 'draft_1',
      images: ['a', 'b'].map((id) => ({
        id,
        status: 'PROCESSING',
        processedUrl: null,
      })),
    });
    expect(reenqueueImage).toHaveBeenCalledTimes(2);
    expect(svc.drafts.setImageJobId).toHaveBeenCalledWith('b', 'job_ok');
  });

  it('logs a late enqueue that finally fails instead of dropping it silently', async () => {
    const add = heldCall<{ id: string }>();
    const { svc, logs } = botService({ enqueueImage: add.fn });
    await expect(
      svc.enqueueImageJob('draft_1', 'img_1'),
    ).rejects.toBeInstanceOf(RedisTimeoutError);
    add.pending[0].reject(new Error('Connection is closed.'));
    await flush();
    expect(logs).toContain(
      'error Late enqueue of image img_1 failed: Connection is closed.',
    );
  });

  it('stops waiting on job removal after one timeout, and still issues every removal', async () => {
    const remove = heldCall<void>();
    const { svc } = botService({ removeImageJob: remove.fn });
    const t0 = Date.now();
    await svc.discardDraftJobs({
      id: 'draft_1',
      images: [
        { jobId: 'j1' },
        { jobId: null },
        { jobId: 'j2' },
        { jobId: 'j3' },
      ],
    });
    expect(Date.now() - t0).toBeLessThan(
      TelegramService.QUEUE_TIMEOUT_MS * 2 + 200,
    );
    expect(remove.fn.mock.calls).toEqual([['j1'], ['j2'], ['j3']]);
    for (const p of remove.pending) p.reject(new Error('late failure'));
    await flush(); // no unhandled rejection
  });
});

// ── NotificationsService (reached from the bot's sourcing-offer flow) ───────

describe('NotificationsService.emit with Redis not answering', () => {
  beforeEach(() => {
    jest.replaceProperty(NotificationsService, 'PUSH_ENQUEUE_TIMEOUT_MS', 40);
  });
  afterEach(() => jest.restoreAllMocks());

  function service(enqueueNotification: jest.Mock) {
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
    return { svc, warn };
  }
  const input = {
    type: NotificationType.SOURCING_OFFER,
    title: 't',
    body: 'b',
  };

  it('returns the saved inbox row after the timeout; the push still lands later, once', async () => {
    const add = heldCall<{ id: string }>();
    const { svc, warn } = service(add.fn);

    const t0 = Date.now();
    const row = await svc.emit('user_1', input);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(row.userId).toBe('user_1');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('it is queued once Redis answers'),
    );
    expect(add.fn).toHaveBeenCalledTimes(1);

    add.pending[0].resolve({ id: `notify_${row.id}` });
    await flush();
    expect(add.fn).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing contract for an enqueue that fails outright', async () => {
    const { svc, warn } = service(
      jest.fn().mockRejectedValue(new Error('NOSCRIPT')),
    );
    const row = await svc.emit('user_1', input);
    expect(row.userId).toBe('user_1');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Push enqueue failed for user_1'),
    );
  });
});
