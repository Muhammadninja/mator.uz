/**
 * Test doubles for the Driver's Village Telegram ingest: a scripted Telegram
 * chat, a scripted importer and a logger that keeps its lines. No network,
 * no TDLib, no database — test-only (test/ is excluded from the build).
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ImportReport } from '../../src/imports/drivers-village/drivers-village.report';
import type { IngestConfig } from '../../src/imports/drivers-village/telegram-ingest/config';
import type {
  IncomingDocument,
  IncomingMessage,
} from '../../src/imports/drivers-village/telegram-ingest/document-filter';
import type {
  ImportRequest,
  ImportRunner,
  ImportRunResult,
} from '../../src/imports/drivers-village/telegram-ingest/import-runner';
import type { DocumentSource } from '../../src/imports/drivers-village/telegram-ingest/ingest';
import type {
  LogContext,
  Logger,
  LogLevel,
} from '../../src/imports/drivers-village/telegram-ingest/log';

/** The private chat with the 1C bot (a positive id = the bot's user id). */
export const BOT_CHAT_ID = 7_000_000_001;
export const NOW = new Date('2026-10-18T09:00:00.000Z');

export function privateTempDir(prefix = 'dv-telegram-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return dir;
}

export function testConfig(
  stateDir: string,
  overrides: Partial<IngestConfig> = {},
): IngestConfig {
  return {
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
    stateDir,
    chatId: BOT_CHAT_ID,
    senderIds: [],
    fileNamePattern: /^dv_parts_[A-Za-z0-9_.-]*\.txt$/i,
    allowedMimeTypes: ['text/plain', 'text/tab-separated-values'],
    maxFileBytes: 20 * 1024 * 1024,
    maxAgeHours: 24,
    scanLimit: 50,
    maxAttempts: 3,
    importTimeoutMs: 60_000,
    retentionDays: 30,
    logLevel: 'debug',
    ...overrides,
  };
}

export interface MessageSpec {
  fileName?: string;
  mimeType?: string;
  minutesAgo?: number;
  isOutgoing?: boolean;
  isForwarded?: boolean;
  senderId?: number | null;
  chatId?: number;
  /** No document at all (a text or photo message). */
  noDocument?: boolean;
  /** Override the announced size. */
  size?: number;
}

/** A scripted chat: messages plus the bytes behind each document. */
export class FakeChat implements DocumentSource {
  readonly messages: IncomingMessage[] = [];
  /** Message ids, in the order their documents were downloaded. */
  readonly downloads: number[] = [];
  private readonly files = new Map<
    number,
    { messageId: number; bytes: Buffer }
  >();
  private nextFileId = 1;
  /** The next N downloads throw (a network problem). */
  failDownloads = 0;

  post(
    id: number,
    content: string | Buffer,
    spec: MessageSpec = {},
  ): IncomingMessage {
    const bytes = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content, 'utf-8');
    const fileId = this.nextFileId++;
    const document: IncomingDocument | null = spec.noDocument
      ? null
      : {
          fileId,
          uniqueId: `unique-${fileId}`,
          fileName: spec.fileName ?? `dv_parts_2026_10_18_${id}.txt`,
          mimeType: spec.mimeType ?? 'text/plain',
          size: spec.size ?? bytes.length,
        };
    const message: IncomingMessage = {
      id,
      chatId: spec.chatId ?? BOT_CHAT_ID,
      date: Math.floor(NOW.getTime() / 1000) - (spec.minutesAgo ?? 5) * 60,
      isOutgoing: spec.isOutgoing ?? false,
      senderId: spec.senderId === undefined ? BOT_CHAT_ID : spec.senderId,
      isForwarded: spec.isForwarded ?? false,
      document,
    };
    this.files.set(fileId, { messageId: id, bytes });
    this.messages.push(message);
    return message;
  }

  listRecentMessages(limit: number): Promise<IncomingMessage[]> {
    return Promise.resolve(
      [...this.messages].sort((a, b) => b.id - a.id).slice(0, limit),
    );
  }

  download(document: IncomingDocument, destination: string): Promise<void> {
    const file = this.files.get(document.fileId)!;
    this.downloads.push(file.messageId);
    if (this.failDownloads > 0) {
      this.failDownloads -= 1;
      return Promise.reject(new Error('network is unreachable'));
    }
    writeFileSync(destination, file.bytes, { flag: 'wx', mode: 0o600 });
    return Promise.resolve();
  }
}

type Scripted =
  | Partial<ImportRunResult>
  | ((request: ImportRequest) => Partial<ImportRunResult>);

/** An importer whose results are scripted; records every request. */
export class ScriptedImporter implements ImportRunner {
  readonly calls: ImportRequest[] = [];
  readonly script: Scripted[] = [];

  run(request: ImportRequest): Promise<ImportRunResult> {
    this.calls.push(request);
    const next = this.script.shift() ?? succeeded();
    const partial = typeof next === 'function' ? next(request) : next;
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      spawnError: null,
      report: reportStub(),
      reportPath: join(request.reportDir, 'drivers-village-import-x.json'),
      ...partial,
    });
  }
}

export function succeeded(
  overrides: Partial<ImportReport['summary']> = {},
): Partial<ImportRunResult> {
  return { exitCode: 0, report: reportStub({ summary: overrides }) };
}

/** The slice of an importer report the ingest reads. */
export function reportStub(
  patch: {
    meta?: Partial<ImportReport['meta']>;
    summary?: Partial<ImportReport['summary']>;
    environmentErrors?: string[];
  } = {},
): ImportReport {
  const report = {
    meta: { mode: 'import', aborted: false, abortReason: null, ...patch.meta },
    environment: {
      issues: (patch.environmentErrors ?? []).map((message) => ({
        line: null,
        code1c: null,
        kind: 'reference',
        severity: 'error',
        code: 'linked_seller_missing',
        field: null,
        message,
      })),
    },
    summary: {
      totalRows: 3,
      validRows: 3,
      rejectedRows: 0,
      rowsToCreate: 3,
      rowsToUpdate: 0,
      rowsUnchanged: 0,
      rowsMerged: 0,
      rowsWithPartNumberChange: 0,
      written: {
        created: 3,
        updated: 0,
        skippedUnchanged: 0,
        projected: 3,
        projectionFailures: 0,
      },
      ...patch.summary,
    },
  };
  return report as unknown as ImportReport;
}

export class MemoryLogger implements Logger {
  readonly lines: { level: LogLevel; message: string; context?: LogContext }[] =
    [];
  debug(message: string, context?: LogContext): void {
    this.lines.push({ level: 'debug', message, context });
  }
  info(message: string, context?: LogContext): void {
    this.lines.push({ level: 'info', message, context });
  }
  warn(message: string, context?: LogContext): void {
    this.lines.push({ level: 'warn', message, context });
  }
  error(message: string, context?: LogContext): void {
    this.lines.push({ level: 'error', message, context });
  }
  text(): string {
    return this.lines
      .map((l) => `${l.level} ${l.message} ${JSON.stringify(l.context ?? {})}`)
      .join('\n');
  }
}
