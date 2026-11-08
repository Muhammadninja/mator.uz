// Task 3 — recovering from `409 Conflict` without fighting whoever holds the
// updates. On the REAL installed Telegraf; only the network is replaced
// (Telegram.prototype.callApi is stubbed — no request leaves the process).
//
// Pinned here:
//   • a 409 pauses polling: status error/conflict, no aggressive retry;
//   • re-checks are read-only (getWebhookInfo) on a growing, capped backoff;
//   • the app never deletes or sets a webhook, never uses launch(), never
//     repeats getMe (polling-webhook.spec.ts pins every start path);
//   • polling resumes by itself once the conflict is gone, and only then
//     reports running; the backoff resets only after a stable period;
//   • one polling loop at a time; nothing restarts after stop().

import { HttpStatus } from '@nestjs/common';
import { Telegraf, Telegram, TelegramError } from 'telegraf';
import { HealthController } from '../health/health.controller';
import { BotPollingSupervisor } from './bot-polling';
import {
  CONFLICT_RETRY_BASE_MS,
  CONFLICT_RETRY_JITTER,
  CONFLICT_RETRY_MAX_MS,
  conflictCause,
  conflictRetryDelayMs,
} from './polling-conflict';
import { TelegramPollingStatus } from './polling-status';

const TOKEN = '123456:TEST-ONLY-NOT-A-REAL-TOKEN-0123456789abcdef';
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Mator',
  username: 'mator_test_bot',
};
const OTHER_POLLER =
  'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
const WEBHOOK_SET =
  "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first";

const conflict = (description: string) =>
  new TelegramError({ error_code: 409, description });

describe('conflict policy', () => {
  it('backs off from 30 s, doubling, capped at 5 min, with bounded jitter', () => {
    const none = () => 0;
    expect(conflictRetryDelayMs(1, none)).toBe(CONFLICT_RETRY_BASE_MS);
    expect(conflictRetryDelayMs(2, none)).toBe(2 * CONFLICT_RETRY_BASE_MS);
    expect(conflictRetryDelayMs(3, none)).toBe(4 * CONFLICT_RETRY_BASE_MS);
    expect(conflictRetryDelayMs(20, none)).toBe(CONFLICT_RETRY_MAX_MS);
    const most = () => 0.999999;
    expect(conflictRetryDelayMs(20, most)).toBeLessThanOrEqual(
      Math.round(CONFLICT_RETRY_MAX_MS * (1 + CONFLICT_RETRY_JITTER)),
    );
    expect(conflictRetryDelayMs(1, most)).toBeGreaterThan(
      CONFLICT_RETRY_BASE_MS,
    );
  });

  it("tells the two causes apart from Telegram's description", () => {
    expect(conflictCause(conflict(OTHER_POLLER))).toBe('other_poller');
    expect(conflictCause(conflict(WEBHOOK_SET))).toBe('webhook');
    expect(conflictCause(conflict('Conflict'))).toBe('unknown');
  });
});

// ── On the real Telegraf ────────────────────────────────────────────────────

type Payload = Record<string, any>;
type Answer = (payload: Payload, opts: { signal?: AbortSignal }) => unknown;

function idlePoll(opts: { signal?: AbortSignal }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), 10);
    opts.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

function stubBotApi(answer: Record<string, Answer>) {
  const calls: { method: string; at: number }[] = [];
  jest
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(
      async (method: any, payload: any = {}, opts: any = {}) => {
        calls.push({ method, at: Date.now() });
        if (answer[method]) return answer[method](payload, opts);
        if (method === 'getMe') return BOT_INFO;
        if (method === 'getWebhookInfo')
          return { url: '', pending_update_count: 0 };
        if (method === 'getUpdates')
          return payload.limit === 1 ? [] : idlePoll(opts);
        return true;
      },
    );
  return {
    count: (m: string) => calls.filter((c) => c.method === m).length,
    methods: () => calls.map((c) => c.method),
  };
}

async function waitFor(condition: () => boolean, what: string, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const running: { supervisor: BotPollingSupervisor; bot: Telegraf }[] = [];
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

beforeEach(() => {
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
});
afterEach(() => {
  for (const { supervisor, bot } of running.splice(0)) {
    supervisor.stop();
    try {
      bot.stop('test cleanup');
    } catch {
      // not running
    }
  }
  jest.restoreAllMocks();
  process.off('unhandledRejection', onRejection);
  expect(rejections).toEqual([]); // main.ts exits on one
});

function supervise(
  policy: { delay?: (n: number) => number; stableMs?: number } = {},
) {
  const logs: string[] = [];
  const record = (level: string) => (m: unknown) =>
    logs.push(`${level} ${String(m)}`);
  const bot = new Telegraf(TOKEN);
  const launch = jest.spyOn(bot, 'launch');
  const delays: number[] = [];
  const supervisor = new BotPollingSupervisor(
    bot,
    { log: record('log'), warn: record('warn'), error: record('error') },
    () => 5,
    {
      delay: (n) => {
        delays.push(n);
        return policy.delay ? policy.delay(n) : 20;
      },
      stableMs: policy.stableMs ?? 60_000,
    },
  );
  const status = new TelegramPollingStatus();
  status.attach(supervisor);
  running.push({ supervisor, bot });
  return { bot, supervisor, status, logs, launch, delays };
}

/** getUpdates answers 409 `times` times (`description`), then polls normally. */
function conflictingPolls(times: number, description = OTHER_POLLER): Answer {
  let left = times;
  return (payload, opts) => {
    if (payload.limit === 1) return [];
    if (left > 0) {
      left -= 1;
      throw conflict(description);
    }
    return idlePoll(opts);
  };
}

describe('409 Conflict on the real Telegraf', () => {
  it('pauses on a 409 and does not poll again until the re-check is due', async () => {
    const api = stubBotApi({ getUpdates: conflictingPolls(1) });
    const { supervisor, status, logs } = supervise({ delay: () => 150 });

    supervisor.start();
    await waitFor(() => supervisor.status === 'conflict', 'the 409');

    const s = status.current();
    expect([s.status, s.reason]).toEqual(['error', 'conflict']);
    expect(s.conflict).toMatchObject({ cause: 'other_poller', attempts: 1 });
    expect(s.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(s.lastError).toBe('conflict');
    expect(
      logs.filter((l) => l.startsWith('error Bot polling PAUSED')),
    ).toHaveLength(1);

    await sleep(80); // well inside the 150 ms wait
    expect(api.count('getUpdates')).toBe(1);
    expect(api.count('getWebhookInfo')).toBe(1); // the connect's own check only
  });

  it('resumes by itself once the other poller is gone — read-only check, no getMe, no deleteWebhook, no launch()', async () => {
    const api = stubBotApi({ getUpdates: conflictingPolls(1) });
    const { supervisor, status, logs, launch } = supervise({ stableMs: 40 });

    supervisor.start();
    await waitFor(
      () => status.current().status === 'running',
      'polling to resume',
    );

    expect(api.count('getWebhookInfo')).toBe(2); // the connect's + the re-check
    expect(api.count('getMe')).toBe(1); // the connect only
    expect(api.count('deleteWebhook')).toBe(0);
    expect(api.count('setWebhook')).toBe(0);
    expect(launch).not.toHaveBeenCalled();
    expect(logs).toContain(
      'log Bot polling resumed after the conflict — getUpdates answered',
    );

    // The incident closes only after polling has stayed clear for stableMs.
    expect(status.current().conflict).not.toBeNull();
    await waitFor(
      () => status.current().conflict === null,
      'the conflict to be over',
    );
    expect(logs).toContainEqual(
      expect.stringMatching(/^log Bot polling conflict resolved/),
    );
    expect(supervisor.status).toBe('polling');
  });

  it('waits out a webhook set after the start without touching it, on a growing backoff, then resumes', async () => {
    let webhookChecks = 0;
    const api = stubBotApi({
      getUpdates: conflictingPolls(1, WEBHOOK_SET),
      getWebhookInfo: () => {
        webhookChecks += 1;
        // None at the connect; set by someone before the first poll; then gone.
        const set = webhookChecks === 2 || webhookChecks === 3;
        return {
          url: set ? 'https://example.invalid/hook' : '',
          pending_update_count: 3,
        };
      },
    });
    const { supervisor, status, logs, delays } = supervise();

    supervisor.start();
    await waitFor(() => supervisor.status === 'conflict', 'the 409');
    expect(status.current().conflict?.cause).toBe('webhook');

    await waitFor(
      () => status.current().status === 'running',
      'the webhook to be gone',
    );
    expect(delays).toEqual([1, 2, 3]); // one wait per check, each backed off further
    expect(api.count('getWebhookInfo')).toBe(4);
    // While the webhook was set, nothing but the read-only check was called.
    const polled = api
      .methods()
      .filter((m) => m === 'getUpdates' || m === 'getWebhookInfo');
    expect(polled.slice(0, 6)).toEqual([
      'getWebhookInfo', // the connect: none yet
      'getUpdates', // the 409
      'getWebhookInfo',
      'getWebhookInfo',
      'getWebhookInfo', // gone
      'getUpdates', // the resumed loop
    ]);
    expect(api.count('deleteWebhook')).toBe(0);
    expect(api.count('setWebhook')).toBe(0);
    expect(
      logs.filter((l) => l.startsWith('warn Bot polling still in conflict')),
    ).toHaveLength(2);
    // The webhook URL never reaches the logs or the status.
    expect(logs.join('\n')).not.toContain('example.invalid');
    expect(JSON.stringify(status.current())).not.toContain('example.invalid');
  });

  it('keeps backing off while another poller stays — no tight retry loop', async () => {
    const api = stubBotApi({
      getUpdates: conflictingPolls(Number.POSITIVE_INFINITY),
    });
    const { supervisor, status, delays } = supervise({
      delay: (n) => 10 * 2 ** n,
    });

    supervisor.start();
    await sleep(400); // delays 20, 40, 80, 160 ms → about 4 re-checks fit

    expect(supervisor.status).toBe('conflict');
    // One getUpdates per webhook check (the connect's, then each re-check's):
    // nothing in between.
    expect(api.count('getUpdates')).toBe(api.count('getWebhookInfo'));
    expect(api.count('getUpdates')).toBeLessThanOrEqual(6);
    expect(delays).toEqual(delays.map((_, i) => i + 1)); // never reset to the base
    expect(status.current().conflict?.attempts).toBe(delays.length);
    expect(api.count('deleteWebhook')).toBe(0);
  });

  it('a 409 inside the stable window continues the same incident and its backoff', async () => {
    let polls = 0;
    stubBotApi({
      getUpdates: (payload, opts) => {
        if (payload.limit === 1) return [];
        polls += 1;
        // 409, a resumed loop that answers once, then a 409 again.
        if (polls === 1 || polls === 3) throw conflict(OTHER_POLLER);
        return polls === 2 ? [] : idlePoll(opts);
      },
    });
    const { supervisor, status, delays } = supervise({ stableMs: 60_000 });

    supervisor.start();
    await waitFor(() => delays.length === 2, 'the second conflict');
    expect(status.current().conflict?.attempts).toBe(2);
    await waitFor(
      () => status.current().status === 'running',
      'the second resume',
    );
    expect(delays).toEqual([1, 2]);
  });

  it('stops for good during a conflict: the pending re-check never runs', async () => {
    const api = stubBotApi({ getUpdates: conflictingPolls(1) });
    const { supervisor, status } = supervise({ delay: () => 30 });

    supervisor.start();
    await waitFor(() => supervisor.status === 'conflict', 'the 409');
    supervisor.stop();
    await sleep(80);

    expect(api.count('getWebhookInfo')).toBe(1); // the connect's; no re-check
    expect(api.count('getUpdates')).toBe(1);
    expect([status.current().status, status.current().reason]).toEqual([
      'stopped',
      'shutdown',
    ]);
  });

  it('does not resume when shutdown lands while the webhook check is in flight', async () => {
    let answerCheck: () => void = () => undefined;
    let checks = 0;
    const api = stubBotApi({
      getUpdates: conflictingPolls(1),
      // The connect's check answers; the re-check is held.
      getWebhookInfo: () =>
        ++checks === 1
          ? { url: '' }
          : new Promise(
              (resolve) => (answerCheck = () => resolve({ url: '' })),
            ),
    });
    const { supervisor } = supervise();

    supervisor.start();
    await waitFor(() => api.count('getWebhookInfo') === 2, 'the re-check');
    supervisor.stop();
    answerCheck();
    await sleep(40);

    expect(api.count('getUpdates')).toBe(1);
    expect(supervisor.status).toBe('stopped');
  });

  it('a revoked token found by a re-check is permanent', async () => {
    let revokedChecks = 0;
    stubBotApi({
      getUpdates: conflictingPolls(1),
      getWebhookInfo: () => {
        if (++revokedChecks === 1) return { url: '' }; // the connect's
        throw new TelegramError({
          error_code: 401,
          description: 'Unauthorized',
        });
      },
    });
    const { supervisor, status, delays } = supervise();
    supervisor.start();
    await waitFor(() => supervisor.status === 'failed', 'the 401');
    expect(status.current().reason).toBe('unauthorized');
    expect(delays).toEqual([1]); // it came from the re-check after the 409
  });

  it('keeps waiting when the re-check itself cannot reach Telegram', async () => {
    let checks = 0;
    stubBotApi({
      getUpdates: conflictingPolls(1),
      getWebhookInfo: () => {
        // The connect's check answers; the first re-check cannot reach Telegram.
        if (++checks === 2) {
          throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), {
            name: 'FetchError',
          });
        }
        return { url: '' };
      },
    });
    const { status, supervisor, logs, delays } = supervise();
    supervisor.start();
    await waitFor(() => status.current().status === 'running', 'the resume');
    expect(delays).toEqual([1, 2]);
    expect(logs).toContainEqual(
      expect.stringContaining(
        'the webhook check failed: getaddrinfo EAI_AGAIN',
      ),
    );
  });
});

describe('one poller inside the app', () => {
  it('start() during a conflict connects nothing — only the re-check may resume', async () => {
    const api = stubBotApi({ getUpdates: conflictingPolls(1) });
    const { supervisor, launch } = supervise({ delay: () => 200 });

    supervisor.start();
    await waitFor(() => supervisor.status === 'conflict', 'the 409');
    supervisor.start();
    supervisor.start();
    await sleep(30);

    expect(api.count('getWebhookInfo')).toBe(1); // the first connect only
    expect(api.count('getUpdates')).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(supervisor.status).toBe('conflict');
  });

  it('refuses a second polling loop while one runs, and the first keeps polling', async () => {
    const api = stubBotApi({});
    const { bot, supervisor, logs } = supervise();
    supervisor.start();
    await waitFor(() => supervisor.status === 'polling', 'the loop');

    await expect((bot as any).startPolling()).rejects.toThrow(
      'a polling loop is already running in this process',
    );
    const polls = api.count('getUpdates');
    await waitFor(
      () => api.count('getUpdates') > polls + 1,
      'the first loop to go on',
    );
    expect(supervisor.status).toBe('polling');
    expect(logs.filter((l) => l.includes('long polling active'))).toHaveLength(
      1,
    );
  });

  it('never has two getUpdates in flight across a conflict and its recovery', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let polls = 0;
    stubBotApi({
      getUpdates: async (payload, opts) => {
        if (payload.limit === 1) return [];
        polls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await sleep(2);
          if (polls <= 3) throw conflict(OTHER_POLLER);
          return await idlePoll(opts);
        } finally {
          inFlight -= 1;
        }
      },
    });
    const { supervisor, status } = supervise({ delay: () => 5 });
    supervisor.start();
    await waitFor(() => status.current().status === 'running', 'the recovery');
    expect(maxInFlight).toBe(1);
  });
});

describe('/health/telegram through a conflict', () => {
  it('is 503 error/conflict while paused and 200 running once recovered', async () => {
    stubBotApi({ getUpdates: conflictingPolls(1) });
    const { supervisor, status } = supervise({ delay: () => 60 });
    const health = new HealthController(
      { $queryRaw: jest.fn() } as never,
      status,
    );
    const res = {
      statusCode: 0,
      status: (c: number) => ((res.statusCode = c), res),
    };

    supervisor.start();
    await waitFor(() => supervisor.status === 'conflict', 'the 409');
    const paused = health.telegram(res as never);
    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(paused).toMatchObject({
      status: 'error',
      reason: 'conflict',
      conflict: { cause: 'other_poller', attempts: 1 },
    });
    expect(typeof paused.nextAttemptAt).toBe('string');

    await waitFor(() => status.current().status === 'running', 'the recovery');
    const resumed = health.telegram(res as never);
    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(resumed).toMatchObject({ status: 'running', reason: null });
  });
});
