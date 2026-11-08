// Task 1 — the seller bot's polling status in /health and the metrics.
//
// The derivation is pure and tested on its own; the supervisor's facts are
// tested on the REAL installed Telegraf with only the network replaced
// (Telegram.prototype.callApi is stubbed — no request leaves the process).

import { HttpStatus } from '@nestjs/common';
import { Registry } from 'prom-client';
import { Telegraf, Telegram, TelegramError } from 'telegraf';
import { HealthController } from '../health/health.controller';
import {
  DEFAULT_METRICS_PREFIX,
  type MetricsConfig,
} from '../metrics/metrics.config';
import { createAppMetrics } from '../metrics/metrics.definitions';
import { MetricsService } from '../metrics/metrics.service';
import { TelegramPollingCollector } from '../metrics/telegram-polling.collector';
import { BotPollingSupervisor } from './bot-polling';
import {
  POLLING_STALE_AFTER_MS,
  TelegramPollingStatus,
  derivePollingSnapshot,
  pollingHealthView,
  type PollingFacts,
} from './polling-status';

const TOKEN = '123456:TEST-ONLY-NOT-A-REAL-TOKEN-0123456789abcdef';
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Mator',
  username: 'mator_test_bot',
};
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

function facts(over: Partial<PollingFacts>): PollingFacts {
  return {
    state: 'idle',
    since: T0,
    consecutiveFailures: 0,
    recovering: false,
    ...over,
  };
}

describe('derivePollingSnapshot', () => {
  it.each([
    ['idle', {}, 'stopped', 'not_started'],
    ['stopped', {}, 'stopped', 'shutdown'],
    ['starting', {}, 'starting', 'launching'],
    ['starting', { recovering: true }, 'starting', 'recovering'],
    ['retrying', {}, 'error', 'transient_failure'],
    ['conflict', {}, 'error', 'conflict'],
    ['failed', { failedReason: 'unauthorized' }, 'error', 'unauthorized'],
    ['failed', { failedReason: 'incompatible' }, 'error', 'incompatible'],
  ] as const)('%s %j → %s / %s', (state, over, status, reason) => {
    const s = derivePollingSnapshot(facts({ state, ...over }), T0 + 1_000);
    expect([s.status, s.reason]).toEqual([status, reason]);
  });

  it('reports a new loop as starting until Telegram answers its getUpdates, then running', () => {
    const loop = facts({ state: 'polling', loopStartedAt: T0 });
    expect(derivePollingSnapshot(loop, T0 + 10_000).status).toBe('starting');

    const answered = { ...loop, lastPollAt: T0 + 5_000 };
    const s = derivePollingSnapshot(answered, T0 + 10_000);
    expect([s.status, s.reason]).toEqual(['running', null]);
  });

  it('does not count an answer to an EARLIER loop', () => {
    const s = derivePollingSnapshot(
      facts({ state: 'polling', loopStartedAt: T0, lastPollAt: T0 - 1 }),
      T0 + 1_000,
    );
    expect(s.status).toBe('starting');
  });

  it('turns to error/stalled once getUpdates has been silent too long', () => {
    const f = facts({ state: 'polling', loopStartedAt: T0, lastPollAt: T0 });
    expect(derivePollingSnapshot(f, T0 + POLLING_STALE_AFTER_MS).status).toBe(
      'running',
    );
    const s = derivePollingSnapshot(f, T0 + POLLING_STALE_AFTER_MS + 1);
    expect([s.status, s.reason]).toEqual(['error', 'stalled']);
    // A loop that never got a single answer stalls too.
    const never = facts({ state: 'polling', loopStartedAt: T0 });
    expect(
      derivePollingSnapshot(never, T0 + POLLING_STALE_AFTER_MS + 1).reason,
    ).toBe('stalled');
  });

  it('serves ISO times and only enums and numbers — nothing secret', () => {
    const view = pollingHealthView(
      derivePollingSnapshot(
        facts({
          state: 'conflict',
          lastPollAt: T0,
          lastErrorAt: T0 + 1,
          lastError: 'conflict',
          nextAttemptAt: T0 + 30_000,
          conflict: { cause: 'webhook', since: T0, attempts: 2 },
        }),
        T0 + 2,
      ),
    );
    expect(view).toEqual({
      status: 'error',
      reason: 'conflict',
      since: '2026-11-08T12:00:00.000Z',
      lastPollAt: '2026-11-08T12:00:00.000Z',
      lastUpdateAt: null,
      lastErrorAt: '2026-11-08T12:00:00.001Z',
      lastError: 'conflict',
      nextAttemptAt: '2026-11-08T12:00:30.000Z',
      consecutiveFailures: 0,
      conflict: {
        cause: 'webhook',
        since: '2026-11-08T12:00:00.000Z',
        attempts: 2,
      },
    });
  });
});

describe('TelegramPollingStatus', () => {
  it('is stopped/not_started until the bot attaches, stopped/disabled when it never polls', () => {
    const status = new TelegramPollingStatus();
    expect([status.current().status, status.current().reason]).toEqual([
      'stopped',
      'not_started',
    ]);
    status.markDisabled();
    expect([status.current().status, status.current().reason]).toEqual([
      'stopped',
      'disabled',
    ]);
  });

  it('reads the attached supervisor live', () => {
    const status = new TelegramPollingStatus();
    let state: PollingFacts['state'] = 'starting';
    status.attach({ pollingFacts: () => facts({ state }) });
    expect(status.current().status).toBe('starting');
    state = 'retrying';
    expect(status.current().status).toBe('error');
  });
});

// ── The supervisor's facts, on the real Telegraf ───────────────────────────

type Answer = (
  payload: Record<string, any>,
  opts: { signal?: AbortSignal },
) => unknown;

/** An empty long poll: answers [] after a moment, or at once when aborted. */
function idlePoll(opts: { signal?: AbortSignal }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), 10);
    opts.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

/** getUpdates answers each `batches` entry once, then idles like a long poll. */
function stubBotApi(batches: unknown[][], answer: Record<string, Answer> = {}) {
  const calls: { method: string; payload: Record<string, any> }[] = [];
  let next = 0;
  jest
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(
      async (method: any, payload: any = {}, opts: any = {}) => {
        calls.push({ method, payload });
        if (answer[method]) return answer[method](payload, opts);
        if (method === 'getMe') return BOT_INFO;
        if (method !== 'getUpdates') return true;
        if (payload.limit === 1) return [];
        if (next < batches.length) return batches[next++];
        return idlePoll(opts);
      },
    );
  return { count: (m: string) => calls.filter((c) => c.method === m).length };
}

async function waitFor(condition: () => boolean, what: string, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const quietLogger = { log() {}, warn() {}, error() {} };
const started: { supervisor: BotPollingSupervisor; bot: Telegraf }[] = [];

function supervise(retryDelay?: (n: number) => number) {
  const bot = new Telegraf(TOKEN);
  const supervisor = new BotPollingSupervisor(bot, quietLogger, retryDelay);
  const status = new TelegramPollingStatus();
  status.attach(supervisor);
  started.push({ supervisor, bot });
  return { bot, supervisor, status };
}

afterEach(() => {
  for (const { supervisor, bot } of started.splice(0)) {
    supervisor.stop();
    try {
      bot.stop('test cleanup');
    } catch {
      // not running
    }
  }
  jest.restoreAllMocks();
});

const update = (id: number) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    chat: { id: 7, type: 'private' },
    text: 'hi',
  },
});

describe('BotPollingSupervisor status facts (real Telegraf)', () => {
  it('goes starting → running once getUpdates answers, and stopped on shutdown', async () => {
    let releaseFirst: (v: unknown[]) => void = () => undefined;
    let first = true;
    stubBotApi([], {
      getUpdates: (payload, opts) => {
        if (payload.limit === 1) return [];
        if (first) {
          first = false;
          return new Promise((resolve) => (releaseFirst = resolve));
        }
        return idlePoll(opts);
      },
    });
    const { supervisor, status } = supervise();

    expect(status.current().status).toBe('stopped');
    supervisor.start();
    expect([status.current().status, status.current().reason]).toEqual([
      'starting',
      'launching',
    ]);
    await waitFor(() => supervisor.status === 'polling', 'the loop to start');
    // The loop exists, but Telegram has not answered it yet.
    expect(status.current().status).toBe('starting');

    releaseFirst([]);
    await waitFor(
      () => status.current().status === 'running',
      'the first answer',
    );
    expect(status.current().lastPollAt).not.toBeNull();
    expect(status.current().lastUpdateAt).toBeNull(); // an empty poll is no update

    supervisor.stop();
    expect([status.current().status, status.current().reason]).toEqual([
      'stopped',
      'shutdown',
    ]);
  });

  it('moves lastPollAt on every answer and lastUpdateAt only when updates arrive', async () => {
    const api = stubBotApi([[], [update(1)]]);
    const { supervisor, status } = supervise();
    supervisor.start();

    await waitFor(() => status.current().lastUpdateAt !== null, 'the update');
    const firstUpdateAt = status.current().lastUpdateAt!;
    const polls = api.count('getUpdates');
    const pollAt = status.current().lastPollAt!;
    await waitFor(
      () => api.count('getUpdates') > polls + 2,
      'more empty polls',
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(status.current().lastPollAt!).toBeGreaterThanOrEqual(pollAt);
    expect(status.current().lastUpdateAt).toBe(firstUpdateAt);
    expect(status.current().status).toBe('running');
  });

  it('reports a transient failure as error with the next attempt, then recovering, then running', async () => {
    let failuresLeft = 1;
    stubBotApi([], {
      getMe: () => {
        if (failuresLeft-- > 0) {
          throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), {
            name: 'FetchError',
          });
        }
        return BOT_INFO;
      },
    });
    const { supervisor, status } = supervise(() => 40);
    supervisor.start();

    await waitFor(() => supervisor.status === 'retrying', 'the retry');
    const s = status.current();
    expect([s.status, s.reason, s.consecutiveFailures]).toEqual([
      'error',
      'transient_failure',
      1,
    ]);
    expect(s.nextAttemptAt).toBeGreaterThan(Date.now() - 1);

    await waitFor(() => status.current().status === 'running', 'the recovery');
    expect(status.current().nextAttemptAt).toBeNull();
  });

  it('records a getUpdates failure that Telegraf retries inside its loop', async () => {
    let failed = false;
    stubBotApi([], {
      getUpdates: (payload, opts) => {
        if (payload.limit === 1) return [];
        if (!failed) {
          failed = true;
          throw new TelegramError({
            error_code: 502,
            description: 'Bad Gateway',
            parameters: { retry_after: 0 },
          });
        }
        return idlePoll(opts);
      },
    });
    const { supervisor, status } = supervise();
    supervisor.start();

    await waitFor(
      () => status.current().status === 'running',
      'the loop to answer',
    );
    expect(status.current().lastError).toBe('server_error');
    expect(status.current().lastErrorAt).not.toBeNull();
  });

  it('reports a revoked token as error/unauthorized', async () => {
    stubBotApi([], {
      getMe: () => {
        throw new TelegramError({
          error_code: 401,
          description: 'Unauthorized',
        });
      },
    });
    const { supervisor, status } = supervise();
    supervisor.start();
    await waitFor(() => supervisor.status === 'failed', 'the 401');
    expect([status.current().status, status.current().reason]).toEqual([
      'error',
      'unauthorized',
    ]);
  });
});

// ── /health ─────────────────────────────────────────────────────────────────

function fakeRes() {
  const res = {
    statusCode: 200,
    status: jest.fn((code: number) => ((res.statusCode = code), res)),
  };
  return res;
}

function statusWith(
  state: PollingFacts['state'],
  over: Partial<PollingFacts> = {},
) {
  const status = new TelegramPollingStatus();
  status.attach({ pollingFacts: () => facts({ state, ...over }) });
  return status;
}

describe('HealthController and the bot', () => {
  const dbUp = { $queryRaw: jest.fn().mockResolvedValue([1]) };
  const dbDown = { $queryRaw: jest.fn().mockRejectedValue(new Error('down')) };

  it('keeps /health answering by the database alone, carrying the bot status', async () => {
    const health = new HealthController(
      dbUp as never,
      statusWith('failed', { failedReason: 'unauthorized' }),
    );
    await expect(health.ready()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      telegram: { polling: 'error', reason: 'unauthorized' },
    });
  });

  it('leaves the /health contract as it was without a polling status, and on a DB outage', async () => {
    await expect(new HealthController(dbUp as never).ready()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });
    await expect(
      new HealthController(dbDown as never, statusWith('polling')).ready(),
    ).rejects.toMatchObject({
      response: { status: 'error', database: 'down' },
    });
  });

  it.each([
    [
      'polling',
      { loopStartedAt: Date.now(), lastPollAt: Date.now() },
      HttpStatus.OK,
      'running',
    ],
    ['starting', {}, HttpStatus.OK, 'starting'],
    ['retrying', {}, HttpStatus.SERVICE_UNAVAILABLE, 'error'],
    ['conflict', {}, HttpStatus.SERVICE_UNAVAILABLE, 'error'],
    ['stopped', {}, HttpStatus.SERVICE_UNAVAILABLE, 'stopped'],
  ] as const)(
    '/health/telegram with %s → %i %s',
    (state, over, code, shown) => {
      const res = fakeRes();
      const body = new HealthController(
        dbUp as never,
        statusWith(state, over),
      ).telegram(res as never);
      expect(res.statusCode).toBe(code);
      expect(body.status).toBe(shown);
    },
  );

  it('/health/telegram is 200 for an instance that deliberately does not poll', () => {
    const status = new TelegramPollingStatus();
    status.markDisabled();
    const res = fakeRes();
    const body = new HealthController(dbUp as never, status).telegram(
      res as never,
    );
    expect([res.statusCode, body.status, body.reason]).toEqual([
      200,
      'stopped',
      'disabled',
    ]);
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

function metricsService() {
  const config: MetricsConfig = {
    enabled: true,
    path: '/metrics',
    prefix: DEFAULT_METRICS_PREFIX,
    queueMetricsEnabled: true,
    smsCostMetricsEnabled: true,
  };
  const registry = new Registry();
  return {
    service: new MetricsService(
      createAppMetrics(registry, config),
      registry,
      config,
    ),
    registry,
  };
}

describe('Telegram polling metrics', () => {
  it('publishes the status as a state set and the poll times in unix seconds', async () => {
    const { service, registry } = metricsService();
    const now = Date.now();
    new TelegramPollingCollector(
      service,
      statusWith('polling', {
        loopStartedAt: now - 5_000,
        lastPollAt: now - 1_000,
        lastUpdateAt: now - 2_000,
      }),
    ).collect();

    const text = await registry.metrics();
    expect(text).toContain('mator_telegram_polling_status{status="running"} 1');
    expect(text).toContain('mator_telegram_polling_status{status="error"} 0');
    expect(text).toContain(
      'mator_telegram_polling_status{status="starting"} 0',
    );
    expect(text).toContain('mator_telegram_polling_status{status="stopped"} 0');
    expect(text).toContain(
      `mator_telegram_polling_last_poll_timestamp_seconds ${Math.floor((now - 1_000) / 1000)}`,
    );
    expect(text).toContain(
      `mator_telegram_polling_last_update_timestamp_seconds ${Math.floor((now - 2_000) / 1000)}`,
    );
  });

  it('reads 0 for a time that never happened, and publishes nothing without a status', async () => {
    const { service, registry } = metricsService();
    new TelegramPollingCollector(service, statusWith('conflict')).collect();
    const text = await registry.metrics();
    expect(text).toContain('mator_telegram_polling_status{status="error"} 1');
    expect(text).toContain(
      'mator_telegram_polling_last_poll_timestamp_seconds 0',
    );

    const empty = metricsService();
    new TelegramPollingCollector(empty.service).collect();
    expect(await empty.registry.metrics()).not.toContain(
      'mator_telegram_polling_status{',
    );
  });
});
