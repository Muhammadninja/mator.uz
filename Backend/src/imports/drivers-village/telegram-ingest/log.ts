/**
 * One-line logs for the Telegram ingest (journald / PM2 capture stdout and
 * stderr):
 *
 *   2026-10-18T09:00:01.234Z INFO  [dv-telegram] imported {"messageId":…}
 *
 * The ingest never passes a secret to the logger — not the api_hash, the
 * phone number, a login code, a 2FA password or session data. As a second
 * line of defence every secret the process handles is registered with
 * `addSecret`, and any occurrence of it in a line is replaced before writing.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVELS, value);
}

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export type LineWriter = (line: string, level: LogLevel) => void;

const writeToStdio: LineWriter = (line, level) => {
  const stream =
    level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

export class IngestLogger implements Logger {
  private readonly secrets = new Set<string>();

  constructor(
    private readonly scope = 'dv-telegram',
    private readonly minLevel: LogLevel = 'info',
    private readonly write: LineWriter = writeToStdio,
  ) {}

  /** Never print this value; very short values are ignored (too common). */
  addSecret(value: string | null | undefined): void {
    if (value && value.trim().length >= 4) this.secrets.add(value.trim());
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets)
      out = out.split(secret).join('[redacted]');
    return out;
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const ctx =
      context && Object.keys(context).length ? ` ${safeJson(context)}` : '';
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${ctx}`;
    this.write(this.redact(line), level);
  }
}

/** Error message only — never a stack with arguments or a request payload. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  // Errors from another realm (vm contexts, some native bindings).
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
  )
    return (error as { message: string }).message;
  return typeof error === 'string' ? error : 'unknown error';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable context]"';
  }
}
