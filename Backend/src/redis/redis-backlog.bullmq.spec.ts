// The cap under a long outage on the REAL bullmq + ioredis, against a local
// port nothing listens on (Redis down). In its own file: the adds it leaves
// behind can never settle, and the backlog counter is per module registry.

import { createServer } from 'node:net';
import { Queue } from 'bullmq';
import {
  makeFakeLock,
  type TelegramServiceHarness,
} from '../telegram/draft-lock.test-util';
import { TelegramService } from '../telegram/telegram.service';
import {
  MAX_UNANSWERED_REDIS_COMMANDS as MAX,
  RedisUnavailableError,
  unansweredRedisCommands,
} from './redis-backlog';

it('never has more than the cap of BullMQ adds outstanding, however many photos arrive', async () => {
  jest.replaceProperty(TelegramService, 'QUEUE_TIMEOUT_MS', 1);
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  const queue = new Queue('backlog-probe', {
    connection: {
      host: '127.0.0.1',
      port,
      maxRetriesPerRequest: null,
      retryStrategy: () => 50,
    },
  });
  queue.on('error', () => undefined);
  const add = jest.spyOn(queue, 'add');

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
    queue: {
      enqueueImage: (data: { draftId: string; imageId: string }) =>
        queue.add('process', data, {
          jobId: `image_${data.draftId}_${data.imageId}`,
        }),
    },
  });

  try {
    // Three times the cap in photos (albums of 10), Redis down throughout —
    // the same loop shape as the bot's enqueue paths.
    for (let d = 0; d < (3 * MAX) / 10; d++) {
      let stalled = false;
      for (let i = 0; i < 10; i++) {
        if (stalled) {
          svc.deferImageJob(`d${d}`, `i${i}`, 'enqueue');
          continue;
        }
        try {
          await svc.enqueueImageJob(`d${d}`, `i${i}`);
        } catch (err) {
          stalled = err instanceof RedisUnavailableError;
        }
      }
    }
    expect(add).toHaveBeenCalledTimes(MAX);
    expect(unansweredRedisCommands()).toBe(MAX);
    expect(
      warn.filter((l) => l.includes('left PROCESSING for the next /start'))
        .length,
    ).toBeGreaterThan(0);
  } finally {
    (queue as any).connection?._client?.disconnect?.(false);
  }
}, 30_000);
