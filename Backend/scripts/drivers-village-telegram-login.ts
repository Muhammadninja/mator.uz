/**
 * Driver's Village Telegram ingest — authorize the Telegram account once.
 * An operator runs this ON THE SERVER, in an interactive terminal, as the user
 * that runs the ingest. It refuses to run without a terminal.
 *
 *   npm run drivers-village:telegram-login                   # sign in: phone → code → 2FA password
 *   npm run drivers-village:telegram-login -- --list-chats   # also list chats with their ids
 *                                                            # (to set DV_TELEGRAM_CHAT_ID)
 *   npm run drivers-village:telegram-login -- --logout       # end this session at Telegram and
 *                                                            # delete it locally
 *
 * The phone number is typed visibly; the login code and the 2FA password are
 * typed hidden. None of them is printed, logged, stored or passed on the
 * command line — they go straight to TDLib, which keeps only the resulting
 * session in DV_TELEGRAM_STATE_DIR/tdlib (0700, outside the repository).
 * Needs DV_TELEGRAM_API_ID, DV_TELEGRAM_API_HASH and DV_TELEGRAM_STATE_DIR.
 */
import { config as loadDotenv } from 'dotenv';
import type * as tdl from 'tdl';
import {
  acquireLock,
  LockBusyError,
} from '../src/imports/drivers-village/import-lock';
import {
  ConfigError,
  loadCredentials,
  loadStateDir,
} from '../src/imports/drivers-village/telegram-ingest/config';
import { sessionPaths } from '../src/imports/drivers-village/telegram-ingest/state-paths';
import {
  errorMessage,
  IngestLogger,
} from '../src/imports/drivers-village/telegram-ingest/log';
import {
  assertPrivateIfExists,
  assertPrivateStateDir,
  ensurePrivateDir,
} from '../src/imports/drivers-village/telegram-ingest/secure-fs';
import {
  authorizationState,
  closeQuietly,
  openTdlib,
} from '../src/imports/drivers-village/telegram-ingest/tdlib-client';
import {
  askHidden,
  askVisible,
  isInteractiveTerminal,
} from '../src/imports/drivers-village/telegram-ingest/terminal-prompt';

type Action = 'login' | 'list-chats' | 'logout';

const MAX_TRIES = 3;

function parseAction(argv: string[]): Action {
  if (argv.length === 0) return 'login';
  if (argv.length === 1 && argv[0] === '--list-chats') return 'list-chats';
  if (argv.length === 1 && argv[0] === '--logout') return 'logout';
  throw new ConfigError(
    'Usage: npm run drivers-village:telegram-login [-- --list-chats | --logout]',
  );
}

/** Log in through TDLib's flow with our prompts — never tdl's echoing defaults. */
async function login(client: tdl.Client, log: IngestLogger): Promise<void> {
  const tries = new Map<string, number>();
  const guard = (step: string, retry?: boolean) => {
    const n = (tries.get(step) ?? 0) + 1;
    tries.set(step, n);
    if (n > MAX_TRIES)
      throw new Error(
        `Too many rejected attempts (${step}); start again later.`,
      );
    if (retry) console.log(`Telegram rejected that ${step}; try again.`);
  };
  const secret = (value: string) => {
    log.addSecret(value);
    return value.trim();
  };
  await client.login({
    type: 'user',
    getPhoneNumber: async (retry) => {
      guard('phone number', retry);
      const phone = secret(
        await askVisible(
          'Phone number of the Telegram account (international format, +998…): ',
        ),
      );
      return phone.replace(/[\s()-]/g, '');
    },
    getAuthCode: async (retry) => {
      guard('login code', retry);
      return secret(
        await askHidden('Login code from Telegram (input hidden): '),
      );
    },
    getPassword: async (_hint, retry) => {
      guard('password', retry);
      return secret(
        await askHidden('Two-step verification password (input hidden): '),
      );
    },
    getEmailAddress: async () => {
      guard('e-mail address');
      return secret(
        await askVisible(
          'Telegram asks for a login e-mail address for this account: ',
        ),
      );
    },
    getEmailCode: async () => {
      guard('e-mail code');
      return secret(
        await askHidden('Code sent to that e-mail (input hidden): '),
      );
    },
    confirmOnAnotherDevice: () => {
      throw new Error(
        'QR-code login is not supported here; use the phone number flow.',
      );
    },
    getName: () => {
      throw new Error(
        'This phone number has no Telegram account. Registering one is not supported.',
      );
    },
  });
}

async function printMe(client: tdl.Client): Promise<void> {
  const me = await client.invoke({ _: 'getMe' });
  const username = me.usernames?.active_usernames[0];
  console.log(
    `Authorized as user id ${me.id}${username ? ` (@${username})` : ''}. The phone number is not shown.`,
  );
}

/** Chats with their ids, to choose DV_TELEGRAM_CHAT_ID (the chat the 1C bot posts to). */
async function listChats(client: tdl.Client): Promise<void> {
  try {
    await client.invoke({
      _: 'loadChats',
      chat_list: { _: 'chatListMain' },
      limit: 100,
    });
  } catch {
    // 404: every chat is already loaded.
  }
  const { chat_ids } = await client.invoke({
    _: 'getChats',
    chat_list: { _: 'chatListMain' },
    limit: 100,
  });
  console.log('\nchat id            type        title');
  for (const id of chat_ids) {
    const chat = await client.invoke({ _: 'getChat', chat_id: id });
    let type: string = chat.type._.replace('chatType', '').toLowerCase();
    if (chat.type._ === 'chatTypePrivate') {
      const user = await client.invoke({
        _: 'getUser',
        user_id: chat.type.user_id,
      });
      type = user.type._ === 'userTypeBot' ? 'bot' : 'private';
    } else if (chat.type._ === 'chatTypeSupergroup' && chat.type.is_channel) {
      type = 'channel';
    }
    console.log(`${String(id).padEnd(18)} ${type.padEnd(11)} ${chat.title}`);
  }
  console.log(
    '\nSet DV_TELEGRAM_CHAT_ID to the id of the chat the 1C bot posts the export to.',
  );
}

async function main(): Promise<number> {
  process.umask(0o077);
  loadDotenv({ quiet: true });
  const log = new IngestLogger('dv-telegram-login');
  if (!isInteractiveTerminal()) {
    log.error(
      'This command is interactive: run it in a terminal on the server (not from cron, CI or a pipe).',
    );
    return 1;
  }
  let action: Action;
  let credentials: ReturnType<typeof loadCredentials>;
  let stateDir: string;
  try {
    action = parseAction(process.argv.slice(2));
    credentials = loadCredentials(process.env);
    stateDir = loadStateDir(process.env);
    log.addSecret(credentials.apiHash);
    assertPrivateStateDir(stateDir, process.cwd());
  } catch (error) {
    log.error(errorMessage(error));
    return 1;
  }
  const paths = sessionPaths(stateDir);
  let lock: ReturnType<typeof acquireLock>;
  try {
    assertPrivateIfExists(paths.tdlib);
    assertPrivateIfExists(paths.tdlibDatabase);
    lock = acquireLock(paths.lock, {
      label: `drivers-village:telegram-login ${action}`,
    });
  } catch (error) {
    log.error(
      error instanceof LockBusyError
        ? `A sync is running (${error.message}). Stop the timer first: sudo systemctl stop mator-dv-telegram-sync.timer`
        : errorMessage(error),
    );
    return 1;
  }
  try {
    ensurePrivateDir(paths.tdlibDatabase);
    ensurePrivateDir(paths.tdlibFiles);
    const client = openTdlib(
      credentials,
      { database: paths.tdlibDatabase, files: paths.tdlibFiles },
      log,
    );
    try {
      const state = await authorizationState(client);
      if (action === 'logout') {
        if (state === 'authorizationStateReady') {
          await client.invoke({ _: 'logOut' });
          console.log(
            'Logged out: the session is ended at Telegram and its local database is destroyed.',
          );
        } else {
          console.log('There is no authorized session to log out of.');
        }
        return 0;
      }
      if (state === 'authorizationStateReady') {
        console.log(
          'Already authorized. (To use another account: --logout, then log in again.)',
        );
      } else {
        await login(client, log);
      }
      await printMe(client);
      if (action === 'list-chats') await listChats(client);
      return 0;
    } finally {
      await closeQuietly(client);
    }
  } catch (error) {
    log.error(`login failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    lock.release();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[dv-telegram-login] FAILED: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
