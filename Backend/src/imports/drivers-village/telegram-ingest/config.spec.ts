import { IMPORT_LIMITS } from '../drivers-village.constants';
import {
  ConfigError,
  DEFAULT_MIME_TYPES,
  loadCredentials,
  loadIngestConfig,
  loadStateDir,
} from './config';

const HASH = '0123456789abcdef0123456789abcdef';
const BASE = {
  DV_TELEGRAM_API_ID: '12345',
  DV_TELEGRAM_API_HASH: HASH,
  DV_TELEGRAM_STATE_DIR: '/var/lib/mator-dv-telegram',
  DV_TELEGRAM_CHAT_ID: '7000000001',
};

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
}

describe('Telegram ingest configuration', () => {
  it('reads a minimal private-chat setup with safe defaults', () => {
    const config = loadIngestConfig(BASE);
    expect(config).toMatchObject({
      apiId: 12345,
      apiHash: HASH,
      stateDir: '/var/lib/mator-dv-telegram',
      chatId: 7000000001,
      senderIds: [],
      allowedMimeTypes: DEFAULT_MIME_TYPES,
      maxFileBytes: IMPORT_LIMITS.maxFileBytes,
      maxAgeHours: 24,
      scanLimit: 50,
      maxAttempts: 6,
      importTimeoutMs: 30 * 60_000,
      retentionDays: 30,
      logLevel: 'info',
    });
    expect(config.fileNamePattern.test('dv_parts_2026_10_18.txt')).toBe(true);
    expect(config.fileNamePattern.test('DV_PARTS_2026_10_18.TXT')).toBe(true);
    expect(config.fileNamePattern.test('dv_parts_2026_10_18.xlsx')).toBe(false);
    expect(config.fileNamePattern.test('price.txt')).toBe(false);
  });

  it('never repeats the api_hash in an error', () => {
    const bad = 'not-a-hash-but-a-secret-anyway';
    const error = errorOf(() =>
      loadCredentials({ ...BASE, DV_TELEGRAM_API_HASH: bad }),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).not.toContain(bad);
  });

  it.each([
    [{ DV_TELEGRAM_API_ID: '' }, 'DV_TELEGRAM_API_ID'],
    [{ DV_TELEGRAM_API_ID: '12a' }, 'DV_TELEGRAM_API_ID'],
    [{ DV_TELEGRAM_API_HASH: 'abc' }, 'DV_TELEGRAM_API_HASH'],
    [{ DV_TELEGRAM_STATE_DIR: '' }, 'DV_TELEGRAM_STATE_DIR'],
    [{ DV_TELEGRAM_STATE_DIR: 'state/telegram' }, 'absolute'],
    [{ DV_TELEGRAM_CHAT_ID: '' }, 'DV_TELEGRAM_CHAT_ID is required'],
    [{ DV_TELEGRAM_CHAT_ID: '@dv_bot' }, 'DV_TELEGRAM_CHAT_ID'],
    [{ DV_TELEGRAM_FILE_PATTERN: '([' }, 'DV_TELEGRAM_FILE_PATTERN'],
    [
      { DV_TELEGRAM_ALLOWED_MIME_TYPES: 'text plain' },
      'DV_TELEGRAM_ALLOWED_MIME_TYPES',
    ],
    [
      { DV_TELEGRAM_MAX_FILE_BYTES: String(IMPORT_LIMITS.maxFileBytes + 1) },
      'DV_TELEGRAM_MAX_FILE_BYTES',
    ],
    [{ DV_TELEGRAM_MAX_ATTEMPTS: '0' }, 'DV_TELEGRAM_MAX_ATTEMPTS'],
    [{ DV_TELEGRAM_SCAN_LIMIT: '-1' }, 'DV_TELEGRAM_SCAN_LIMIT'],
    [{ DV_TELEGRAM_LOG_LEVEL: 'trace' }, 'DV_TELEGRAM_LOG_LEVEL'],
  ])('rejects %j', (patch, message) => {
    const error = errorOf(() => loadIngestConfig({ ...BASE, ...patch }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(message);
  });

  it('requires explicit senders for a group or channel', () => {
    const group = { ...BASE, DV_TELEGRAM_CHAT_ID: '-1001234567890' };
    expect(errorOf(() => loadIngestConfig(group)).message).toContain(
      'DV_TELEGRAM_SENDER_IDS is required',
    );
    expect(
      loadIngestConfig({ ...group, DV_TELEGRAM_SENDER_IDS: '7000000001, 42' })
        .senderIds,
    ).toEqual([7000000001, 42]);
  });

  it('accepts overrides within bounds', () => {
    const config = loadIngestConfig({
      ...BASE,
      DV_TELEGRAM_FILE_PATTERN: '^export_.*\\.tsv$',
      DV_TELEGRAM_ALLOWED_MIME_TYPES: 'TEXT/TAB-SEPARATED-VALUES',
      DV_TELEGRAM_MAX_FILE_BYTES: '1048576',
      DV_TELEGRAM_MAX_AGE_HOURS: '72',
      DV_TELEGRAM_IMPORT_TIMEOUT_MINUTES: '5',
      DV_TELEGRAM_LOG_LEVEL: 'DEBUG',
    });
    expect(config.fileNamePattern.test('export_1.tsv')).toBe(true);
    expect(config).toMatchObject({
      allowedMimeTypes: ['text/tab-separated-values'],
      maxFileBytes: 1048576,
      maxAgeHours: 72,
      importTimeoutMs: 5 * 60_000,
      logLevel: 'debug',
    });
  });

  it('normalizes the state directory path', () => {
    expect(loadStateDir({ DV_TELEGRAM_STATE_DIR: '/var/lib//dv/' })).toBe(
      '/var/lib/dv',
    );
  });
});
