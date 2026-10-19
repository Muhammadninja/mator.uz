/**
 * Configuration of the Driver's Village Telegram ingest, read from the
 * environment (Backend/.env or a systemd EnvironmentFile). Only the ingest
 * scripts read these variables; the HTTP app never does.
 *
 * Validation messages never repeat a value: DV_TELEGRAM_API_HASH is secret,
 * and the rest is not worth echoing into logs.
 */
import { isAbsolute, normalize } from 'path';
import { IMPORT_LIMITS } from '../drivers-village.constants';
import { isLogLevel, type LogLevel } from './log';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export interface FilterRules {
  /** The one chat whose messages are read (TDLib / Bot API chat id). */
  chatId: number;
  /** Allowed senders (user or chat ids). Empty: the private chat's peer. */
  senderIds: number[];
  /** Matched against the file name as sent (case-insensitive). */
  fileNamePattern: RegExp;
  allowedMimeTypes: string[];
  maxFileBytes: number;
  maxAgeHours: number;
}

export interface IngestConfig extends TelegramCredentials, FilterRules {
  stateDir: string;
  scanLimit: number;
  maxAttempts: number;
  importTimeoutMs: number;
  retentionDays: number;
  logLevel: LogLevel;
}

/** The export 1C sends: dv_parts_<date>.txt (tab-delimited text). */
export const DEFAULT_FILE_NAME_PATTERN = '^dv_parts_[A-Za-z0-9_.-]*\\.txt$';
export const DEFAULT_MIME_TYPES = ['text/plain', 'text/tab-separated-values'];

type Env = NodeJS.ProcessEnv;

export function loadCredentials(env: Env): TelegramCredentials {
  const apiId = env.DV_TELEGRAM_API_ID?.trim() ?? '';
  if (!/^[1-9][0-9]{0,9}$/.test(apiId))
    throw new ConfigError(
      'DV_TELEGRAM_API_ID must be the numeric api_id from my.telegram.org.',
    );
  const apiHash = env.DV_TELEGRAM_API_HASH?.trim() ?? '';
  if (!/^[0-9a-f]{32}$/i.test(apiHash))
    throw new ConfigError(
      'DV_TELEGRAM_API_HASH must be the 32-character api_hash from my.telegram.org.',
    );
  return { apiId: Number(apiId), apiHash };
}

export function loadStateDir(env: Env): string {
  const dir = env.DV_TELEGRAM_STATE_DIR?.trim() ?? '';
  if (!dir)
    throw new ConfigError(
      'DV_TELEGRAM_STATE_DIR is required (e.g. /var/lib/mator-dv-telegram).',
    );
  if (!isAbsolute(dir))
    throw new ConfigError('DV_TELEGRAM_STATE_DIR must be an absolute path.');
  return normalize(dir).replace(/\/+$/, '') || '/';
}

export function loadLogLevel(env: Env): LogLevel {
  const level = env.DV_TELEGRAM_LOG_LEVEL?.trim().toLowerCase() || 'info';
  if (!isLogLevel(level))
    throw new ConfigError(
      'DV_TELEGRAM_LOG_LEVEL must be one of debug, info, warn, error.',
    );
  return level;
}

export function loadIngestConfig(env: Env): IngestConfig {
  const chatId = parseChatId(env.DV_TELEGRAM_CHAT_ID, 'DV_TELEGRAM_CHAT_ID');
  if (chatId === null)
    throw new ConfigError(
      'DV_TELEGRAM_CHAT_ID is required: the id of the chat 1C posts the export to (list chats with `npm run drivers-village:telegram-login -- --list-chats`).',
    );
  const senderIds = (env.DV_TELEGRAM_SENDER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const id = parseChatId(s, 'DV_TELEGRAM_SENDER_IDS');
      if (id === null)
        throw new ConfigError('DV_TELEGRAM_SENDER_IDS is malformed.');
      return id;
    });
  if (chatId < 0 && senderIds.length === 0)
    throw new ConfigError(
      'DV_TELEGRAM_SENDER_IDS is required when DV_TELEGRAM_CHAT_ID is a group or channel (negative id): list the ids allowed to post exports.',
    );

  return {
    ...loadCredentials(env),
    stateDir: loadStateDir(env),
    chatId,
    senderIds,
    fileNamePattern: parsePattern(env.DV_TELEGRAM_FILE_PATTERN),
    allowedMimeTypes: parseMimeTypes(env.DV_TELEGRAM_ALLOWED_MIME_TYPES),
    maxFileBytes: int(
      env,
      'DV_TELEGRAM_MAX_FILE_BYTES',
      IMPORT_LIMITS.maxFileBytes,
      1,
      IMPORT_LIMITS.maxFileBytes,
    ),
    maxAgeHours: int(env, 'DV_TELEGRAM_MAX_AGE_HOURS', 24, 1, 24 * 30),
    scanLimit: int(env, 'DV_TELEGRAM_SCAN_LIMIT', 50, 1, 500),
    maxAttempts: int(env, 'DV_TELEGRAM_MAX_ATTEMPTS', 6, 1, 50),
    importTimeoutMs:
      int(env, 'DV_TELEGRAM_IMPORT_TIMEOUT_MINUTES', 30, 1, 24 * 60) * 60_000,
    retentionDays: int(env, 'DV_TELEGRAM_RETENTION_DAYS', 30, 1, 3650),
    logLevel: loadLogLevel(env),
  };
}

function parseChatId(raw: string | undefined, name: string): number | null {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  if (!/^-?[1-9][0-9]{0,15}$/.test(value))
    throw new ConfigError(`${name} must be an integer chat or user id.`);
  const id = Number(value);
  if (!Number.isSafeInteger(id))
    throw new ConfigError(`${name} is out of range.`);
  return id;
}

function parsePattern(raw: string | undefined): RegExp {
  const source = raw?.trim() || DEFAULT_FILE_NAME_PATTERN;
  if (source.length > 200)
    throw new ConfigError(
      'DV_TELEGRAM_FILE_PATTERN is longer than 200 characters.',
    );
  try {
    return new RegExp(source, 'i');
  } catch {
    throw new ConfigError(
      'DV_TELEGRAM_FILE_PATTERN is not a valid regular expression.',
    );
  }
}

function parseMimeTypes(raw: string | undefined): string[] {
  if (!raw?.trim()) return [...DEFAULT_MIME_TYPES];
  const types = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (
    !types.length ||
    types.some((t) => !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t))
  )
    throw new ConfigError(
      'DV_TELEGRAM_ALLOWED_MIME_TYPES must be a comma-separated list such as text/plain,text/tab-separated-values.',
    );
  return types;
}

function int(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw))
    throw new ConfigError(`${name} must be a whole number.`);
  const value = Number(raw);
  if (value < min || value > max)
    throw new ConfigError(`${name} must be between ${min} and ${max}.`);
  return value;
}
