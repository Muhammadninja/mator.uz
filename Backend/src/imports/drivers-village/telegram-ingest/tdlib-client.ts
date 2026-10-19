/**
 * TDLib — Telegram's own client library (https://core.telegram.org/tdlib),
 * through the `tdl` binding and the `prebuilt-tdlib` binaries (both pinned in
 * package.json). TDLib speaks MTProto as a regular user account, which is what
 * reading a chat a 1C bot posts into requires (a bot cannot read another
 * bot's messages, and the Bot API caps downloads at 20 MB).
 *
 * The Telegram session IS the TDLib database (<state>/tdlib/db, td.binlog):
 * whoever can read it can act as the account. It never leaves the state
 * directory, and nothing here logs it, the api_hash or any login input.
 */
import { dirname } from 'path';
import { getTdjson } from 'prebuilt-tdlib';
import * as tdl from 'tdl';
import type * as Td from 'tdlib-types';
import type { TelegramCredentials } from './config';
import { errorMessage, type Logger } from './log';

export interface TdlibPaths {
  database: string;
  files: string;
}

export class NotAuthorizedError extends Error {
  constructor(state: string) {
    super(
      `The Telegram session is not authorized (TDLib state: ${state}). An operator must run on the server: npm run drivers-village:telegram-login`,
    );
    this.name = 'NotAuthorizedError';
  }
}

let configured = false;

/**
 * A TDLib client on the session in `paths`. TDLib creates the database on
 * first use (the login command); the ingest checks for td.binlog first.
 */
export function openTdlib(
  credentials: TelegramCredentials,
  paths: TdlibPaths,
  log: Logger,
): tdl.Client {
  silenceLibraryDebug();
  if (!configured) {
    // verbosity 1 = errors only, to stderr: no requests or payloads.
    tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });
    configured = true;
  }
  const client = tdl.createClient({
    apiId: credentials.apiId,
    apiHash: credentials.apiHash,
    databaseDirectory: paths.database,
    filesDirectory: paths.files,
    tdlibParameters: {
      use_test_dc: false,
      use_message_database: false,
      use_file_database: false,
      use_chat_info_database: true,
      use_secret_chats: false,
      system_language_code: 'en',
      device_model: "Mator · Driver's Village import",
      system_version: 'server',
      application_version: '1.0',
    },
  });
  client.on('error', (error) =>
    log.warn('TDLib client error', { error: errorMessage(error) }),
  );
  return client;
}

/** The current authorization state, once TDLib has applied its parameters. */
export async function authorizationState(
  client: tdl.Client,
): Promise<Td.AuthorizationState['_']> {
  for (let i = 0; i < 100; i += 1) {
    const state = await withTimeout(
      client.invoke({ _: 'getAuthorizationState' }),
      30_000,
      'TDLib did not report its authorization state',
    );
    if (state._ !== 'authorizationStateWaitTdlibParameters') return state._;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('TDLib did not finish initializing');
}

export async function requireAuthorized(client: tdl.Client): Promise<void> {
  const state = await authorizationState(client);
  if (state !== 'authorizationStateReady') throw new NotAuthorizedError(state);
}

export async function closeQuietly(client: tdl.Client): Promise<void> {
  if (client.isClosed()) return;
  try {
    await withTimeout(client.close(), 30_000, 'TDLib did not close in time');
  } catch {
    // The process is about to exit; TDLib's database is crash-safe.
  }
}

export function isTdError(error: unknown, code: number): boolean {
  return error instanceof tdl.TDLibError && error.code === code;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `tdl` logs every request through the `debug` package when DEBUG matches
 * `tdl*` — checkAuthenticationCode, checkAuthenticationPassword and
 * setTdlibParameters (api_hash) included. Switch that off, whatever DEBUG says.
 */
function silenceLibraryDebug(): void {
  delete process.env.DEBUG;
  try {
    const path = require.resolve('debug', {
      paths: [dirname(require.resolve('tdl'))],
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- tdl's own copy of `debug`, not a dependency of ours
    (require(path) as { disable(): string }).disable();
  } catch {
    // No `debug` next to tdl: nothing can log through it.
  }
}
