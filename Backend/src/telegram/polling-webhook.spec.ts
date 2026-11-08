// Polling-only, and the webhook is never changed: Telegraf's launch() is not
// used (it calls deleteWebhook on every start), and no path of the supervisor
// ever calls deleteWebhook or setWebhook. A webhook that is set is waited out
// as a conflict. On the REAL installed Telegraf; only the network is replaced
// (Telegram.prototype.callApi is stubbed — no request leaves the process).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Telegraf, Telegram, TelegramError } from 'telegraf';
import { BotPollingSupervisor } from './bot-polling';
import { TelegramPollingStatus } from './polling-status';

const TOKEN = '123456:TEST-ONLY-NOT-A-REAL-TOKEN-0123456789abcdef';
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Mator',
  username: 'mator_test_bot',
};
const HOOK = 'https://hooks.example.invalid/secret-path-0123';
const OTHER_POLLER =
  'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';

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

const networkError = () =>
  Object.assign(new Error('getaddrinfo EAI_AGAIN api.telegram.org'), {
    name: 'FetchError',
  });

function stubBotApi(answer: Record<string, Answer> = {}) {
  const calls: string[] = [];
  jest
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(
      async (method: any, payload: any = {}, opts: any = {}) => {
        calls.push(method);
        if (answer[method]) return answer[method](payload, opts);
        if (method === 'getMe') return BOT_INFO;
        if (method === 'getWebhookInfo') return { url: '' };
        if (method === 'getUpdates')
          return payload.limit === 1 ? [] : idlePoll(opts);
        return true;
      },
    );
  return {
    count: (m: string) => calls.filter((c) => c === m).length,
    methods: () => [...calls],
  };
}

async function waitFor(condition: () => boolean, what: string, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const running: { supervisor: BotPollingSupervisor; bot: Telegraf }[] = [];
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
});

function supervise() {
  const logs: string[] = [];
  const record = (level: string) => (m: unknown) =>
    logs.push(`${level} ${String(m)}`);
  const bot = new Telegraf(TOKEN);
  const launch = jest.spyOn(bot, 'launch');
  const supervisor = new BotPollingSupervisor(
    bot,
    { log: record('log'), warn: record('warn'), error: record('error') },
    () => 5,
    { delay: () => 15, stableMs: 60_000 },
  );
  const status = new TelegramPollingStatus();
  status.attach(supervisor);
  running.push({ supervisor, bot });
  return { supervisor, status, logs, launch };
}

/** The invariant every test below ends on. */
function expectWebhookUntouched(
  api: ReturnType<typeof stubBotApi>,
  launch: jest.SpyInstance,
  logs: string[],
  status: TelegramPollingStatus,
) {
  expect(api.count('deleteWebhook')).toBe(0);
  expect(api.count('setWebhook')).toBe(0);
  expect(launch).not.toHaveBeenCalled();
  // The webhook URL (it may carry a secret path) is never logged or reported.
  expect(logs.join('\n')).not.toContain('example.invalid');
  expect(JSON.stringify(status.current())).not.toContain('example.invalid');
}

describe('polling-only: the webhook is never deleted', () => {
  it('does not start polling while a webhook is set at boot: error/conflict, cause webhook', async () => {
    let checks = 0;
    const api = stubBotApi({
      getWebhookInfo: () => ({ url: ++checks <= 2 ? HOOK : '' }),
    });
    const { supervisor, status, logs, launch } = supervise();

    supervisor.start();
    await waitFor(() => supervisor.status === 'conflict', 'the webhook');
    const s = status.current();
    expect([s.status, s.reason, s.conflict?.cause]).toEqual([
      'error',
      'conflict',
      'webhook',
    ]);
    expect(s.nextAttemptAt).not.toBeNull();
    expect(api.count('getUpdates')).toBe(0);
    expect(logs).toContainEqual(
      expect.stringMatching(/^error Bot polling PAUSED.*a webhook is set/),
    );

    // Once the webhook is gone, polling starts — by startPolling, not launch().
    await waitFor(() => status.current().status === 'running', 'the resume');
    expect(api.methods().filter((m) => m !== 'getUpdates')).toEqual([
      'getMe',
      'getWebhookInfo', // the connect: set
      'getWebhookInfo', // re-check: still set
      'getWebhookInfo', // re-check: gone
    ]);
    expectWebhookUntouched(api, launch, logs, status);
  });

  it('starts normally when no webhook is set — still without deleteWebhook', async () => {
    const api = stubBotApi();
    const { supervisor, status, logs, launch } = supervise();
    supervisor.start();
    await waitFor(() => status.current().status === 'running', 'polling');
    expect(api.methods().slice(0, 3)).toEqual([
      'getMe',
      'getWebhookInfo',
      'getUpdates',
    ]);
    expectWebhookUntouched(api, launch, logs, status);
  });

  it.each([
    ['getMe', { getMe: true }],
    ['getWebhookInfo', { getWebhookInfo: true }],
  ])(
    'retries a network failure of %s without ever deleting the webhook',
    async (_m, failing) => {
      let left = 2;
      const failOnce = (ok: unknown) => () => {
        if (left-- > 0) throw networkError();
        return ok;
      };
      const api = stubBotApi({
        ...('getMe' in failing ? { getMe: failOnce(BOT_INFO) } : {}),
        ...('getWebhookInfo' in failing
          ? { getWebhookInfo: failOnce({ url: '' }) }
          : {}),
      });
      const { supervisor, status, logs, launch } = supervise();
      supervisor.start();
      await waitFor(() => status.current().status === 'running', 'recovery');
      expect(api.count(Object.keys(failing)[0])).toBe(3);
      expectWebhookUntouched(api, launch, logs, status);
    },
  );

  it('reconnects a loop that died — and waits instead if a webhook appeared meanwhile', async () => {
    let polls = 0;
    let checks = 0;
    const api = stubBotApi({
      getUpdates: (payload, opts) => {
        if (payload.limit === 1) return [];
        polls += 1;
        // Not retried inside Telegraf: the loop ends.
        if (polls === 1) throw new Error('socket closed unexpectedly');
        return idlePoll(opts);
      },
      // None at boot; set by the time the dead loop is reconnected; then gone.
      getWebhookInfo: () => ({ url: ++checks === 2 ? HOOK : '' }),
    });
    const { supervisor, status, logs, launch } = supervise();

    supervisor.start();
    await waitFor(() => supervisor.status === 'conflict', 'the webhook');
    expect(status.current().conflict?.cause).toBe('webhook');
    expect(polls).toBe(1);
    await waitFor(() => status.current().status === 'running', 'the resume');
    expectWebhookUntouched(api, launch, logs, status);
  });

  it('recovers from a 409 (other poller) without deleting the webhook', async () => {
    let conflicts = 1;
    const api = stubBotApi({
      getUpdates: (payload, opts) => {
        if (payload.limit === 1) return [];
        if (conflicts-- > 0) {
          throw new TelegramError({
            error_code: 409,
            description: OTHER_POLLER,
          });
        }
        return idlePoll(opts);
      },
    });
    const { supervisor, status, logs, launch } = supervise();
    supervisor.start();
    await waitFor(() => supervisor.status === 'conflict', 'the 409');
    await waitFor(() => status.current().status === 'running', 'the resume');
    expectWebhookUntouched(api, launch, logs, status);
  });
});

describe('no code path can change the webhook', () => {
  /** Every non-spec .ts file under src/, comments stripped. */
  function sources(dir = join(__dirname, '..')): [string, string][] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) return [];
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return [[path, code] as [string, string]];
    });
  }

  it('has no deleteWebhook, setWebhook or Telegraf launch() call anywhere in src/', () => {
    const offenders = sources()
      .filter(([, code]) =>
        /\.(deleteWebhook|setWebhook|launch)\s*\(|['"](deleteWebhook|setWebhook)['"]/.test(
          code,
        ),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
