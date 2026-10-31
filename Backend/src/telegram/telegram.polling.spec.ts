// The seller bot on the REAL installed Telegraf — its middleware composer,
// handleUpdate (with the handler timeout) and the long-polling loop — instead of
// the hand-made fake bot the other specs drive handlers through. Only the
// network is replaced: Telegram.prototype.callApi is stubbed, so no request
// leaves the process and no real token is involved.
//
// The production outage this pins: ONE failing update ended polling for every
// seller while the process stayed up (no bot.catch; launch() only logged).
//   • a handler that throws, or outlives the handler timeout, costs only its update
//   • an expired button tap no longer fails the action it asked for
//   • a malformed offer deep link is answered, never queried
//   • launch failures: transient → retried with backoff; 401/409 → reported, not retried
//   • nothing polls after shutdown, and shutdown never throws

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Telegraf, Telegram, TelegramError } from 'telegraf';
import {
  BotPollingSupervisor,
  POLLING_RETRY_BASE_MS,
  POLLING_RETRY_MAX_MS,
  SUPPORTED_TELEGRAF_VERSION,
  classifyPollingError,
  errorForLog,
  pollingRetryDelayMs,
  redactBotToken,
} from './bot-polling';
import {
  makeFakeLock,
  type TelegramServiceHarness,
} from './draft-lock.test-util';
import { t } from './i18n';
import { WizardSessionStore } from './product-wizard';
import { TelegramOfferService } from './telegram-offer.service';
import { TelegramService } from './telegram.service';

const TOKEN = '123456:TEST-ONLY-NOT-A-REAL-TOKEN';
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Mator',
  username: 'mator_test_bot',
};
const SELLER = {
  id: 7,
  is_bot: false,
  first_name: 'Dilnoza',
  username: 'dilnoza_parts',
};
const CHAT = { id: SELLER.id, type: 'private' as const };
const ACTIVE_SELLER = { id: 1, status: 'ACTIVE', lang: 'RU' };
/** The first wizard prompt: what an active seller's /start is answered with. */
const PHOTOS_PROMPT = t('ru', 'step.photosFirst');

function command(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: CHAT,
      from: SELLER,
      text,
      entities: [
        { type: 'bot_command', offset: 0, length: text.split(' ')[0].length },
      ],
    },
  };
}

function tap(updateId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: SELLER,
      chat_instance: '1',
      data,
      message: { message_id: 500, date: 0, chat: CHAT, text: 'preview' },
    },
  };
}

/** What a request that never got an answer looks like (node-fetch's FetchError). */
function networkError(): Error {
  return Object.assign(
    new Error(
      'request to https://api.telegram.org/bot123456:[REDACTED]/getMe failed, reason: getaddrinfo EAI_AGAIN api.telegram.org',
    ),
    { name: 'FetchError' },
  );
}

type Payload = Record<string, any>;

/**
 * Stub every Bot API call. getUpdates yields `batches` in order and then idles
 * like a long poll until polling is aborted. `answer` overrides single methods:
 * return a value, or throw to simulate Telegram refusing / the network failing.
 */
function stubBotApi(
  batches: unknown[][],
  answer: Record<
    string,
    (payload: Payload, opts: { signal?: AbortSignal }) => unknown
  > = {},
) {
  const calls: { method: string; payload: Payload }[] = [];
  let next = 0;
  jest
    .spyOn(Telegram.prototype as any, 'callApi')
    .mockImplementation(
      async (method: any, payload: any = {}, opts: any = {}) => {
        calls.push({ method, payload });
        if (answer[method]) return answer[method](payload, opts);
        switch (method) {
          case 'getMe':
            return BOT_INFO;
          case 'getUpdates': {
            if (payload.limit === 1) return []; // the loop's final offset sync
            if (next < batches.length) return batches[next++];
            const signal: AbortSignal | undefined = opts.signal;
            return new Promise((resolve) => {
              const timer = setTimeout(() => resolve([]), 10);
              signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve([]);
              });
            });
          }
          case 'sendMessage':
            return {
              message_id: 1000 + calls.length,
              date: 0,
              chat: { id: payload.chat_id, type: 'private' },
              text: payload.text,
            };
          default:
            return true;
        }
      },
    );
  return {
    count: (method: string) => calls.filter((c) => c.method === method).length,
    /** Every Bot API method called so far, in call order. */
    methods: () => calls.map((c) => c.method),
    /** Every text the bot sent, in order. */
    texts: () =>
      calls
        .filter((c) => c.method === 'sendMessage')
        .map((c) => String(c.payload.text)),
  };
}

async function waitFor(
  condition: () => boolean,
  what: string,
  ms = 2_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingLogger(logs: string[]) {
  const record = (level: string) => (message: unknown) => {
    logs.push(`${level} ${String(message)}`);
  };
  return {
    log: record('log'),
    warn: record('warn'),
    error: record('error'),
    debug() {},
  };
}

// Every service / supervisor a test started is shut down after it, so no
// polling loop outlives its test.
const running: { stop: () => void }[] = [];

/** Stop a bot's own loop as well: one that a broken supervisor let start must
 *  not leak into — and steal the stubbed updates of — the next test. */
function stopQuietly(bot: { stop?: (reason?: string) => void } | undefined) {
  try {
    bot?.stop?.('test cleanup');
  } catch {
    // Not running: nothing to stop.
  }
}

/** A TelegramService wired like production — its REAL onModuleInit — with collaborators stubbed. */
function makeBotService(
  over: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const logs: string[] = [];
  const settings: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    ...env,
  };
  const svc = Object.create(
    TelegramService.prototype,
  ) as TelegramServiceHarness;
  Object.assign(svc, {
    logger: recordingLogger(logs),
    config: { get: (key: string) => settings[key] },
    wizard: new WizardSessionStore(),
    pending: new Map(),
    livePrompt: new Map(),
    liveNotice: new Map(),
    staleNoticeSentAt: new Map(),
    langCache: new Map(),
    draftTtlMs: 24 * 60 * 60 * 1000,
    offerFlow: new TelegramOfferService(
      { sourcingTicket: { findUnique: jest.fn() } } as never,
      {} as never,
      {} as never,
      {} as never,
    ),
    sellers: {
      upsertFromBot: jest.fn().mockResolvedValue(ACTIVE_SELLER),
      findByTgId: jest.fn().mockResolvedValue(ACTIVE_SELLER),
    },
    drafts: {
      findAwaitingPreview: jest.fn().mockResolvedValue(null),
      findImagesInFlight: jest.fn().mockResolvedValue(null),
      findResumable: jest.fn().mockResolvedValue(null),
    },
    locks: makeFakeLock(),
    ...over,
  });
  running.push({
    stop: () => {
      svc.onModuleDestroy();
      stopQuietly(svc.bot);
    },
  });
  return { svc, logs };
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  // Telegraf's DEFAULT error handler prints the whole update here and then
  // rethrows; with bot.catch registered it must never run.
  consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  for (const r of running.splice(0)) r.stop();
  jest.restoreAllMocks();
});

describe('Seller bot on the real Telegraf pipeline', () => {
  it('answers the next /start after a handler throws — one bad update costs only itself', async () => {
    const api = stubBotApi([[command(1, '/start')], [command(2, '/start')]]);
    const { svc, logs } = makeBotService({
      sellers: {
        upsertFromBot: jest
          .fn()
          .mockRejectedValueOnce(new Error("Can't reach database server"))
          .mockResolvedValue(ACTIVE_SELLER),
        findByTgId: jest.fn().mockResolvedValue(ACTIVE_SELLER),
      },
    });

    svc.onModuleInit();

    await waitFor(
      () => api.texts().includes(PHOTOS_PROMPT),
      'the second /start to be answered',
    );
    expect(logs).toContain(
      "error Update 1 (message) failed: Can't reach database server",
    );
    expect(svc.polling.status).toBe('polling');
    const polls = api.count('getUpdates');
    await waitFor(() => api.count('getUpdates') > polls, 'polling to go on');
    // The log names the update, never what is in it.
    expect(logs.join('\n')).not.toContain(SELLER.first_name);
    expect(logs.join('\n')).not.toContain(SELLER.username);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('keeps polling after a handler outlives the handler timeout', async () => {
    const api = stubBotApi([[command(1, '/start')], [command(2, '/start')]]);
    const { svc, logs } = makeBotService({
      sellers: {
        // A DB call that never settles — e.g. a dead connection.
        upsertFromBot: jest
          .fn()
          .mockImplementationOnce(() => new Promise(() => undefined))
          .mockResolvedValue(ACTIVE_SELLER),
        findByTgId: jest.fn().mockResolvedValue(ACTIVE_SELLER),
      },
    });

    svc.onModuleInit();
    // Production keeps Telegraf's 90 s; the pipeline is the same at 50 ms.
    svc.bot.options.handlerTimeout = 50;

    await waitFor(
      () => api.texts().includes(PHOTOS_PROMPT),
      'the /start after the stuck one to be answered',
    );
    expect(logs).toContain(
      'error Update 1 (message) failed: Promise timed out after 50 milliseconds',
    );
    expect(svc.polling.status).toBe('polling');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('still runs a preview button whose tap expired, and keeps going', async () => {
    const api = stubBotApi(
      [[tap(1, 'product:cancel')], [command(2, '/start')]],
      {
        answerCallbackQuery: () => {
          throw new TelegramError({
            error_code: 400,
            description:
              'Bad Request: query is too old and response timeout expired or query ID is invalid',
          });
        },
      },
    );
    const { svc, logs } = makeBotService();

    svc.onModuleInit();

    await waitFor(() => api.texts().includes(PHOTOS_PROMPT), 'the next /start');
    // The cancel the tap asked for completed despite the refused acknowledgement.
    expect(api.texts()[0]).toBe(t('ru', 'draft.addCancelled'));
    expect(logs.filter((line) => line.startsWith('error'))).toEqual([]);
  });

  it('answers a malformed offer deep link without querying with it', async () => {
    const findUnique = jest.fn();
    const api = stubBotApi([
      [command(1, '/start offer_not-a-uuid')],
      [command(2, '/start')],
    ]);
    const { svc } = makeBotService({
      offerFlow: new TelegramOfferService(
        { sourcingTicket: { findUnique } } as never,
        {} as never,
        {} as never,
        {} as never,
      ),
    });

    svc.onModuleInit();

    await waitFor(() => api.texts().includes(PHOTOS_PROMPT), 'the next /start');
    expect(api.texts()[0]).toBe(
      'Заявка не найдена — возможно, она уже закрыта.',
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reports a rejected token once and does not retry it', async () => {
    const api = stubBotApi([], {
      getMe: () => {
        throw new TelegramError({
          error_code: 401,
          description: 'Unauthorized',
        });
      },
    });
    const { svc, logs } = makeBotService();

    svc.onModuleInit();

    await waitFor(
      () => svc.polling.status === 'failed',
      'the 401 to be handled',
    );
    await sleep(50);
    expect(api.count('getMe')).toBe(1);
    expect(api.count('getUpdates')).toBe(0);
    expect(logs).toContainEqual(
      expect.stringContaining(
        'Bot polling STOPPED — Telegram rejected the bot token (401: Unauthorized)',
      ),
    );
  });

  it('stops on a 409 conflict with a diagnosis instead of fighting the other poller', async () => {
    const api = stubBotApi([], {
      getUpdates: () => {
        throw new TelegramError({
          error_code: 409,
          description:
            'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
        });
      },
    });
    const { svc, logs } = makeBotService();

    svc.onModuleInit();

    await waitFor(
      () => svc.polling.status === 'failed',
      'the 409 to be handled',
    );
    await sleep(50);
    expect(api.count('getUpdates')).toBe(1);
    const report = logs.find((line) => line.includes('conflict'));
    expect(report).toContain('terminated by other getUpdates request');
    expect(report).toContain('TELEGRAM_POLLING_DISABLED=true');
  });

  it('schedules a backed-off retry for a transient connect failure, and cancels it on shutdown', async () => {
    const api = stubBotApi([], {
      getMe: () => {
        throw networkError();
      },
    });
    const { svc, logs } = makeBotService();

    svc.onModuleInit();

    await waitFor(
      () => svc.polling.status === 'retrying',
      'a retry to be scheduled',
    );
    expect(logs).toContainEqual(
      expect.stringMatching(
        /^warn Bot polling failed \(request to .*\) — retry 1 in 2s$/,
      ),
    );
    svc.onModuleDestroy();
    expect(svc.polling.status).toBe('stopped');
    await sleep(50);
    expect(api.count('getMe')).toBe(1);
  });

  it('stops polling on shutdown and polls no more', async () => {
    const api = stubBotApi([]);
    const { svc, logs } = makeBotService();

    svc.onModuleInit();
    await waitFor(() => api.count('getUpdates') > 0, 'polling to start');

    svc.onModuleDestroy();

    await waitFor(
      () => logs.includes('log Bot stopped (long polling ended)'),
      'polling to end',
    );
    const polls = api.count('getUpdates');
    await sleep(50);
    expect(api.count('getUpdates')).toBe(polls);
  });

  it('never polls with TELEGRAM_POLLING_DISABLED=true, and still shuts down cleanly', async () => {
    const api = stubBotApi([]);
    const { svc } = makeBotService({}, { TELEGRAM_POLLING_DISABLED: 'true' });

    svc.onModuleInit();
    await sleep(30);

    expect(api.count('getMe')).toBe(0);
    expect(api.count('getUpdates')).toBe(0);
    // Telegraf's own stop() throws "Bot is not running!" here; shutdown must not.
    expect(() => svc.onModuleDestroy()).not.toThrow();
  });

  it('reports an incompatible Telegraf instead of polling unprotected, and keeps the backend up', async () => {
    const api = stubBotApi([]);
    // A Telegraf release whose launch() has no startPolling step.
    const step = Object.getOwnPropertyDescriptor(
      Telegraf.prototype,
      'startPolling',
    ) as PropertyDescriptor;
    delete (Telegraf.prototype as any).startPolling;
    try {
      const { svc, logs } = makeBotService();

      expect(() => svc.onModuleInit()).not.toThrow(); // the API stays up
      await sleep(30);

      expect(svc.polling.status).toBe('failed');
      expect(api.count('getMe')).toBe(0);
      expect(api.count('getUpdates')).toBe(0);
      expect(logs).toContainEqual(
        expect.stringMatching(
          /^error Bot polling STOPPED — incompatible Telegraf: /,
        ),
      );
      expect(logs.some((line) => line.includes('Bot starting'))).toBe(false);
      expect(() => svc.onModuleDestroy()).not.toThrow();
    } finally {
      Object.defineProperty(Telegraf.prototype, 'startPolling', step);
    }
  });
});

describe('Telegraf version pin', () => {
  // The supervisor hooks a step of Telegraf's own launch(), verified on one
  // release: the pin, the lockfile, what is installed and the supervisor's
  // own SUPPORTED_TELEGRAF_VERSION must all name that same release.
  it('pins exactly the Telegraf the lifecycle was verified against', () => {
    const backend = join(__dirname, '..', '..');
    const json = (file: string) =>
      JSON.parse(readFileSync(join(backend, file), 'utf8'));
    const lock = json('package-lock.json');

    expect(SUPPORTED_TELEGRAF_VERSION).toBe('4.16.3');
    expect(json('package.json').dependencies.telegraf).toBe(
      SUPPORTED_TELEGRAF_VERSION,
    );
    expect(lock.packages[''].dependencies.telegraf).toBe(
      SUPPORTED_TELEGRAF_VERSION,
    );
    expect(lock.packages['node_modules/telegraf'].version).toBe(
      SUPPORTED_TELEGRAF_VERSION,
    );
    expect(json('node_modules/telegraf/package.json').version).toBe(
      SUPPORTED_TELEGRAF_VERSION,
    );
  });
});

describe('BotPollingSupervisor', () => {
  function supervise(bot: any, retryDelay?: (n: number) => number) {
    const logs: string[] = [];
    const supervisor = new BotPollingSupervisor(
      bot,
      recordingLogger(logs),
      retryDelay,
    );
    running.push({
      stop: () => {
        supervisor.stop();
        stopQuietly(bot);
      },
    });
    return { supervisor, logs };
  }

  it('retries a transient failure with backoff, then polls on the same bot again', async () => {
    let failuresLeft = 2;
    const api = stubBotApi([[command(1, '/start')]], {
      getMe: () => {
        if (failuresLeft-- > 0) throw networkError();
        return BOT_INFO;
      },
    });
    const bot = new Telegraf(TOKEN);
    bot.start((ctx) => ctx.reply('hello'));
    const attempts: number[] = [];
    const { supervisor, logs } = supervise(bot, (n) => {
      attempts.push(n);
      return 5;
    });

    supervisor.start();

    await waitFor(() => api.texts().includes('hello'), 'the /start reply');
    expect(attempts).toEqual([1, 2]); // each consecutive failure backs off further
    expect(api.count('getMe')).toBe(3);
    expect(supervisor.status).toBe('polling');
    expect(logs).toContain(
      'log Bot connected as @mator_test_bot — long polling active',
    );
  });

  it('never runs two launches at once', () => {
    const bot = {
      launch: jest.fn(() => new Promise<void>(() => undefined)),
      stop: jest.fn(),
      botInfo: undefined,
      startPolling: jest.fn(), // the step a compatible Telegraf has
    };
    const { supervisor } = supervise(bot);

    supervisor.start();
    supervisor.start();

    expect(bot.launch).toHaveBeenCalledTimes(1);
  });

  it('does not restart after stop(), even with a retry pending', async () => {
    const api = stubBotApi([], {
      getMe: () => {
        throw networkError();
      },
    });
    const { supervisor } = supervise(new Telegraf(TOKEN), () => 20);

    supervisor.start();
    await waitFor(() => supervisor.status === 'retrying', 'the retry');
    supervisor.stop();
    await sleep(60);

    expect(api.count('getMe')).toBe(1);
    expect(supervisor.status).toBe('stopped');
  });

  it('turns away a launch that shutdown overtook while it was connecting', async () => {
    let answerGetMe: () => void = () => undefined;
    const api = stubBotApi([], {
      getMe: () =>
        new Promise((resolve) => {
          answerGetMe = () => resolve(BOT_INFO);
        }),
    });
    const { supervisor } = supervise(new Telegraf(TOKEN));

    supervisor.start();
    await waitFor(() => api.count('getMe') === 1, 'the connect to begin');
    // Telegraf's own stop() would throw here: no polling loop exists yet.
    expect(() => supervisor.stop()).not.toThrow();
    answerGetMe();
    await sleep(30);

    expect(api.count('deleteWebhook')).toBe(0);
    expect(api.count('getUpdates')).toBe(0);
    expect(supervisor.status).toBe('stopped');
  });

  // What Telegraf 4.16.3 actually does — launch() = getMe → onLaunch →
  // deleteWebhook → startPolling, its promise settling only when the loop ends —
  // and the lifecycle edges the supervisor has to get right on top of it.
  describe('lifecycle edges on the installed Telegraf', () => {
    // main.ts turns any unhandled rejection into a process exit.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    beforeEach(() => {
      rejections.length = 0;
      process.on('unhandledRejection', onRejection);
    });
    afterEach(() => {
      process.off('unhandledRejection', onRejection);
      expect(rejections).toEqual([]);
    });

    const refusal = (error_code: number, description: string) =>
      new TelegramError({ error_code, description });

    /** A Bot API answer the test releases by hand. */
    function heldAnswer(value: unknown) {
      let release: () => void = () => undefined;
      const answer = () =>
        new Promise((resolve) => {
          release = () => resolve(value);
        });
      return { answer, release: () => release() };
    }

    it('launch() stays pending while polling is healthy, and settles only once polling ends', async () => {
      const api = stubBotApi([]);
      const bot = new Telegraf(TOKEN);
      let settled = false;
      const launch = bot.launch.bind(bot) as (
        ...args: unknown[]
      ) => Promise<void>;
      jest
        .spyOn(bot as any, 'launch')
        .mockImplementation((...args: unknown[]) => {
          const polling = launch(...args);
          void polling.then(
            () => (settled = true),
            () => (settled = true),
          );
          return polling;
        });
      const { supervisor, logs } = supervise(bot);

      supervisor.start();
      await waitFor(() => api.count('getUpdates') >= 3, 'several long polls');

      expect(settled).toBe(false);
      expect(supervisor.status).toBe('polling');
      supervisor.stop();
      await waitFor(() => settled, 'launch() to settle once polling ends');
      expect(logs).toContain('log Bot stopped (long polling ended)');
    });

    it('Telegraf calls onLaunch after getMe — before deleteWebhook and before any getUpdates', async () => {
      const api = stubBotApi([]);
      const bot = new Telegraf(TOKEN);
      let seenAtLaunch: string[] = [];

      const polling = bot.launch(() => {
        seenAtLaunch = api.methods();
      });
      await waitFor(() => api.count('getUpdates') > 0, 'polling to begin');
      bot.stop('test');
      await polling;

      expect(seenAtLaunch).toEqual(['getMe']);
      expect(api.methods().slice(0, 3)).toEqual([
        'getMe',
        'deleteWebhook',
        'getUpdates',
      ]);
    });

    it('does not report polling as active once getMe answers — only once the loop starts', async () => {
      const deleteWebhook = heldAnswer(true);
      const api = stubBotApi([], { deleteWebhook: deleteWebhook.answer });
      const { supervisor, logs } = supervise(new Telegraf(TOKEN));

      supervisor.start();
      await waitFor(() => api.count('deleteWebhook') === 1, 'getMe to answer');

      expect(supervisor.status).toBe('starting');
      expect(logs.some((line) => line.includes('long polling active'))).toBe(
        false,
      );
      deleteWebhook.release();
      await waitFor(() => supervisor.status === 'polling', 'the loop to start');
      expect(logs).toContain(
        'log Bot connected as @mator_test_bot — long polling active',
      );
    });

    it('keeps backing off when failures follow a successful getMe', async () => {
      let failuresLeft = 3;
      const api = stubBotApi([], {
        deleteWebhook: () => {
          if (failuresLeft-- > 0) throw networkError();
          return true;
        },
      });
      const attempts: number[] = [];
      const { supervisor } = supervise(new Telegraf(TOKEN), (n) => {
        attempts.push(n);
        return 5;
      });

      supervisor.start();
      await waitFor(() => supervisor.status === 'polling', 'polling at last');

      expect(attempts).toEqual([1, 2, 3]); // not [1, 1, 1]: getMe is not health
      expect(api.count('getMe')).toBe(1); // Telegraf keeps botInfo across launches
    });

    it('never starts the loop when shutdown lands while deleteWebhook is in flight', async () => {
      const deleteWebhook = heldAnswer(true);
      const api = stubBotApi([[command(1, '/start')]], {
        deleteWebhook: deleteWebhook.answer,
      });
      const bot = new Telegraf(TOKEN);
      const handled = jest.fn();
      bot.start(handled);
      const { supervisor, logs } = supervise(bot);

      supervisor.start();
      await waitFor(() => api.count('deleteWebhook') === 1, 'deleteWebhook');
      // Telegraf's own stop() would throw: its polling loop does not exist yet.
      expect(() => supervisor.stop()).not.toThrow();
      deleteWebhook.release();
      await waitFor(
        () => logs.some((line) => line.startsWith('log Bot stopped')),
        'the pending launch to settle',
      );
      await sleep(30);

      expect(api.count('getUpdates')).toBe(0);
      expect(handled).not.toHaveBeenCalled();
      expect(supervisor.status).toBe('stopped');
    });

    // On a RELAUNCH Telegraf still holds the dead loop, so its stop() does not
    // throw — it quietly stops the stale one while the new launch carries on.
    it('never starts a relaunched loop when shutdown lands during its deleteWebhook', async () => {
      let launches = 0;
      let releaseSecond: () => void = () => undefined;
      const api = stubBotApi([], {
        deleteWebhook: () => {
          launches += 1;
          if (launches === 1) return true;
          return new Promise((resolve) => {
            releaseSecond = () => resolve(true);
          });
        },
        getUpdates: (payload) => {
          if (payload.limit === 1) return []; // the dying loop's offset sync
          throw new Error('socket closed unexpectedly'); // ends the first loop
        },
      });
      const { supervisor } = supervise(new Telegraf(TOKEN), () => 5);

      supervisor.start();
      await waitFor(
        () => launches === 2,
        'the relaunch to reach deleteWebhook',
      );
      const polls = api.count('getUpdates');
      expect(() => supervisor.stop()).not.toThrow();
      releaseSecond();
      await sleep(30);

      expect(api.count('getUpdates')).toBe(polls); // the relaunch never polled
      expect(supervisor.status).toBe('stopped');
    });

    it('restarts a polling loop that died, on the same bot, never with two loops at once', async () => {
      let polls = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      const api = stubBotApi([], {
        getUpdates: (payload, opts) => {
          if (payload.limit === 1) return []; // the dying loop's offset sync
          polls += 1;
          // Not a FetchError/429/5xx, so Telegraf does not retry it: the loop ends.
          if (polls === 2) throw new Error('socket closed unexpectedly');
          if (polls === 3) return [command(1, '/start')];
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise((resolve) => {
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              inFlight -= 1;
              resolve([]);
            };
            setTimeout(finish, 10);
            opts.signal?.addEventListener('abort', finish);
          });
        },
      });
      const bot = new Telegraf(TOKEN);
      bot.start((ctx) => ctx.reply('hello'));
      const attempts: number[] = [];
      const { supervisor } = supervise(bot, (n) => {
        attempts.push(n);
        return 5;
      });

      supervisor.start();
      await waitFor(() => api.texts().includes('hello'), 'the restarted loop');

      expect(attempts).toEqual([1]);
      expect(supervisor.status).toBe('polling');
      expect(maxInFlight).toBe(1);
      expect(api.count('getMe')).toBe(1);
      expect(api.count('deleteWebhook')).toBe(2); // one per launch
    });

    it.each([
      [
        'a 401 from getMe',
        {
          getMe: () => {
            throw refusal(401, 'Unauthorized');
          },
        },
      ],
      [
        'a 401 from getUpdates (token revoked while polling)',
        {
          getUpdates: () => {
            throw refusal(401, 'Unauthorized');
          },
        },
      ],
      [
        'a 409 from getUpdates',
        {
          getUpdates: () => {
            throw refusal(
              409,
              'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
            );
          },
        },
      ],
    ])('%s is never retried, however long we wait', async (_case, answer) => {
      stubBotApi([], answer);
      const bot = new Telegraf(TOKEN);
      const launch = jest.spyOn(bot as any, 'launch');
      // A retry, were one scheduled, would come almost at once.
      const { supervisor } = supervise(bot, () => 1);

      supervisor.start();
      await waitFor(() => supervisor.status === 'failed', 'the failure');
      await sleep(50);

      expect(launch).toHaveBeenCalledTimes(1);
      expect(supervisor.status).toBe('failed');
    });

    it('never launches once stopped', () => {
      const bot = {
        launch: jest.fn(() => new Promise<void>(() => undefined)),
        stop: jest.fn(),
        botInfo: undefined,
        startPolling: jest.fn(), // the step a compatible Telegraf has
      };
      const { supervisor } = supervise(bot);

      supervisor.stop();
      supervisor.start();

      expect(bot.launch).not.toHaveBeenCalled();
      expect(supervisor.status).toBe('stopped');
    });

    // A Telegraf release without the step the supervisor hooks: there is no
    // fallback — polling is never claimed, never started unprotected, and the
    // refusal is permanent, so nothing can retry it.
    it('refuses a Telegraf without startPolling — explicitly, once, and without ever launching it', async () => {
      const api = stubBotApi([]);
      const bot = new Telegraf(TOKEN);
      Object.defineProperty(bot, 'startPolling', { value: undefined });
      const launch = jest.spyOn(bot as any, 'launch');
      // A retry, were one ever scheduled, would come almost at once.
      const { supervisor, logs } = supervise(bot, () => 1);

      supervisor.start();
      supervisor.start(); // a second attempt changes nothing
      await sleep(30);

      expect(launch).not.toHaveBeenCalled();
      expect(api.count('getMe')).toBe(0);
      expect(api.count('getUpdates')).toBe(0);
      expect(supervisor.status).toBe('failed');
      const reports = logs.filter((line) =>
        line.includes('incompatible Telegraf'),
      );
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatch(
        /^error Bot polling STOPPED — incompatible Telegraf: .*telegraf 4\.16\.3/,
      );
      expect(logs.some((line) => line.includes('long polling active'))).toBe(
        false,
      );
    });
  });
});

describe('polling failure policy', () => {
  const telegramError = (error_code: number, retry_after?: number) =>
    new TelegramError({
      error_code,
      description: 'x',
      ...(retry_after === undefined ? {} : { parameters: { retry_after } }),
    });

  it('retries only what can heal by itself', () => {
    expect(classifyPollingError(networkError())).toBe('transient');
    expect(classifyPollingError(telegramError(429))).toBe('transient');
    expect(classifyPollingError(telegramError(502))).toBe('transient');
    expect(classifyPollingError(telegramError(401))).toBe('unauthorized');
    expect(classifyPollingError(telegramError(404))).toBe('unauthorized');
    expect(classifyPollingError(telegramError(409))).toBe('conflict');
    expect(classifyPollingError(telegramError(400))).toBe('rejected');
  });

  it('backs off exponentially up to a ceiling', () => {
    expect(POLLING_RETRY_BASE_MS).toBe(2_000);
    expect([1, 2, 3, 4, 5, 6].map((n) => pollingRetryDelayMs(n))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000,
    ]);
    expect(pollingRetryDelayMs(100)).toBe(POLLING_RETRY_MAX_MS);
  });

  it("waits at least as long as a 429's retry_after", () => {
    expect(pollingRetryDelayMs(1, telegramError(429, 30))).toBe(30_000);
    expect(pollingRetryDelayMs(4, telegramError(429, 1))).toBe(16_000);
  });

  it('keeps bot tokens out of logged messages and stacks', () => {
    const token = '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    expect(
      redactBotToken(`GET https://api.telegram.org/bot${token}/getMe`),
    ).toBe('GET https://api.telegram.org/bot1234567890:[REDACTED]/getMe');
    const err = new Error(`request to /bot${token}/getMe failed`);
    // Read before the message is redacted, the stack keeps the original wording.
    expect(err.stack).toContain(token);
    err.message = err.message.replace(token, '1234567890:[REDACTED]');
    const logged = errorForLog(err);
    expect(logged.message).not.toContain(token);
    expect(logged.stack).not.toContain(token);
  });
});
