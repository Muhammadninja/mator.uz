/**
 * One export through the ingest — download (or reuse the copy kept from an
 * earlier attempt) → verify → same content as the last import? → the existing
 * importer → ledger transition. ingest.ts decides the order and when a pass
 * stops; this module decides what happens to one export.
 */
import { existsSync, renameSync, rmSync, statSync } from 'fs';
import { basename, join } from 'path';
import type { IngestConfig } from './config';
import type { IncomingDocument, IncomingMessage } from './document-filter';
import { classifyImport, type ImportRunner } from './import-runner';
import type { DocumentSource } from './ingest';
import type { Ledger, LedgerEntry } from './ledger';
import { errorMessage, type Logger } from './log';
import { hasNulByte, safeFileName, sha256File } from './secure-fs';
import type { StatePaths } from './state-paths';

export type Candidate = IncomingMessage & { document: IncomingDocument };
export type Step = 'imported' | 'duplicate' | 'failed' | 'waiting';

/** What one pass works with (built by runSync). */
export interface IngestContext {
  config: IngestConfig;
  source: DocumentSource;
  runner: ImportRunner;
  log: Logger;
  now: () => Date;
  signal?: AbortSignal;
  ledger: Ledger;
  paths: StatePaths;
}

/** Delay before retry number `attempts + 1`: 10 min doubling, at most 2 h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(10 * 60_000 * 2 ** Math.max(0, attempts - 1), 2 * 3_600_000);
}

/** Wait after a busy import lock or a stop request (not an attempt). */
export const NOT_COUNTED_RETRY_MS = 5 * 60_000;

/** A downloaded file that can never be imported (not worth a retry). */
export class UnusableFileError extends Error {}

/**
 * `message` is null only for an unfinished entry with a verified local copy
 * (the caller checks hasLocalCopy), which needs no download.
 */
export async function processExport(
  ctx: IngestContext,
  message: Candidate | null,
  existing: LedgerEntry | undefined,
): Promise<Step> {
  const { ledger, paths, log } = ctx;
  let entry = existing ?? newEntry(message!, ctx.now());
  const inboxFile = localPath(ctx, entry);

  // 1. The file: reuse the copy kept from an earlier attempt, else download.
  if (!hasLocalCopy(ctx, entry)) {
    const doc = message!.document;
    entry = { ...entry, status: 'downloading', sha256: null, localFile: null };
    ledger.put(entry, ctx.now());
    try {
      await downloadVerified(ctx, doc, inboxFile);
    } catch (error) {
      if (error instanceof UnusableFileError)
        return fail(
          ctx,
          { ...entry, lastError: error.message },
          inboxFile,
          'rejected',
        );
      if (ctx.signal?.aborted)
        return postpone(ctx, entry, 'stopped during the download');
      return retryLater(
        ctx,
        {
          ...entry,
          attempts: entry.attempts + 1,
          lastError: `download failed: ${errorMessage(error)}`,
        },
        inboxFile,
      );
    }
    entry = {
      ...entry,
      sha256: sha256File(inboxFile),
      localFile: basename(inboxFile),
    };
    log.info('downloaded an export', {
      messageId: entry.messageId,
      fileName: entry.fileName,
      bytes: entry.size,
      sha256: entry.sha256,
    });
  }

  // 2. The same content as the newest import: nothing new to import.
  const last = ledger.lastImported;
  if (last && last.sha256 === entry.sha256) {
    moveInto(paths.archive, inboxFile);
    ledger.put(
      {
        ...entry,
        status: 'duplicate',
        nextAttemptAt: null,
        lastError: null,
        result: `same content as message ${last.messageId}, imported ${last.at}`,
      },
      ctx.now(),
    );
    log.info('skipped an export with the same content as the last import', {
      messageId: entry.messageId,
      sameAs: last.messageId,
    });
    return 'duplicate';
  }

  // 3. Import through the existing importer.
  const reportDir = join(
    paths.reports,
    `${entry.messageId}-${ctx.now().toISOString().replace(/[:.]/g, '-')}`,
  );
  entry = {
    ...entry,
    status: 'importing',
    attempts: entry.attempts + 1,
    nextAttemptAt: null,
    reportDir,
  };
  ledger.put(entry, ctx.now());
  log.info('importing an export', {
    messageId: entry.messageId,
    fileName: entry.fileName,
    attempt: entry.attempts,
    maxAttempts: ctx.config.maxAttempts,
  });
  const result = await ctx.runner.run({
    file: inboxFile,
    reportDir,
    dryRun: false,
    timeoutMs: ctx.config.importTimeoutMs,
    signal: ctx.signal,
  });
  const outcome = classifyImport(result);
  switch (outcome.kind) {
    case 'imported':
      moveInto(paths.archive, inboxFile);
      ledger.put(
        {
          ...entry,
          status: 'imported',
          lastError: null,
          result: `${outcome.detail} (exit ${result.exitCode})`,
        },
        ctx.now(),
      );
      ledger.markImported(entry.messageId, entry.sha256!, ctx.now());
      log.info('imported an export', {
        messageId: entry.messageId,
        fileName: entry.fileName,
        exitCode: result.exitCode,
        result: outcome.detail,
        report: result.reportPath,
      });
      return 'imported';
    case 'rejected':
      return fail(
        ctx,
        { ...entry, lastError: outcome.detail },
        inboxFile,
        'rejected',
      );
    case 'busy':
      // The importer did not run: this was not an attempt.
      return postpone(
        ctx,
        { ...entry, attempts: entry.attempts - 1 },
        outcome.detail,
      );
    case 'retry':
      if (result.aborted)
        return postpone(
          ctx,
          { ...entry, attempts: entry.attempts - 1 },
          outcome.detail,
        );
      return retryLater(
        ctx,
        { ...entry, lastError: outcome.detail },
        inboxFile,
      );
  }
}

/** Download into `target`: complete, the announced size, and text. */
export async function downloadVerified(
  ctx: Pick<IngestContext, 'source' | 'signal'>,
  doc: IncomingDocument,
  target: string,
): Promise<void> {
  const part = `${target}.part`;
  rmSync(part, { force: true });
  try {
    await ctx.source.download(doc, part, ctx.signal);
    const bytes = statSync(part).size;
    if (bytes !== doc.size)
      throw new Error(`got ${bytes} bytes, Telegram announced ${doc.size}`);
    renameSync(part, target);
  } finally {
    rmSync(part, { force: true });
  }
  if (hasNulByte(target))
    throw new UnusableFileError(
      'the file is binary (contains NUL bytes), not the tab-delimited text the importer reads',
    );
}

function retryLater(
  ctx: IngestContext,
  entry: LedgerEntry,
  file: string,
): Step {
  if (entry.attempts >= ctx.config.maxAttempts)
    return fail(ctx, entry, file, 'exhausted');
  const next = new Date(ctx.now().getTime() + retryDelayMs(entry.attempts));
  ctx.ledger.put(
    { ...entry, status: 'retry', nextAttemptAt: next.toISOString() },
    ctx.now(),
  );
  ctx.log.warn('export not imported yet; will retry', {
    messageId: entry.messageId,
    fileName: entry.fileName,
    attempts: entry.attempts,
    maxAttempts: ctx.config.maxAttempts,
    nextAttemptAt: next.toISOString(),
    error: entry.lastError,
  });
  return 'waiting';
}

/**
 * A busy import lock or a stop request: try again soon. The caller passes the
 * entry with its attempts as they were before (this was not an attempt).
 */
function postpone(
  ctx: IngestContext,
  entry: LedgerEntry,
  reason: string,
): Step {
  const next = new Date(ctx.now().getTime() + NOT_COUNTED_RETRY_MS);
  ctx.ledger.put(
    {
      ...entry,
      status: 'retry',
      nextAttemptAt: next.toISOString(),
      lastError: reason,
    },
    ctx.now(),
  );
  ctx.log.warn('export postponed (not counted as an attempt)', {
    messageId: entry.messageId,
    reason,
    nextAttemptAt: next.toISOString(),
  });
  return 'waiting';
}

/** Terminal failure: the file (if any) moves to failed/ for an operator. */
export function fail(
  ctx: IngestContext,
  entry: LedgerEntry,
  file: string,
  why: 'rejected' | 'exhausted' | 'expired',
): Step {
  if (existsSync(file)) moveInto(ctx.paths.failed, file);
  ctx.ledger.put(
    { ...entry, status: 'failed', nextAttemptAt: null },
    ctx.now(),
  );
  ctx.log.error(
    why === 'rejected'
      ? 'export rejected; it will not be retried'
      : why === 'exhausted'
        ? 'export failed; giving up after the last attempt'
        : 'unfinished export is older than DV_TELEGRAM_MAX_AGE_HOURS; giving up',
    {
      messageId: entry.messageId,
      fileName: entry.fileName,
      attempts: entry.attempts,
      error: entry.lastError,
      keptAs: existsSync(join(ctx.paths.failed, basename(file)))
        ? join(ctx.paths.failed, basename(file))
        : null,
      report: entry.reportDir,
    },
  );
  return 'failed';
}

/** Where the export of `entry` is kept in inbox/ while it is unfinished. */
export function localPath(ctx: IngestContext, entry: LedgerEntry): string {
  return join(
    ctx.paths.inbox,
    entry.localFile ?? `${entry.messageId}-${safeFileName(entry.fileName)}`,
  );
}

/** A downloaded copy whose content is the one recorded in the ledger. */
export function hasLocalCopy(ctx: IngestContext, entry: LedgerEntry): boolean {
  const path = localPath(ctx, entry);
  return (
    entry.sha256 !== null &&
    existsSync(path) &&
    sha256File(path) === entry.sha256
  );
}

/** Older than DV_TELEGRAM_MAX_AGE_HOURS: newer exports supersede it. */
export function isExpired(ctx: IngestContext, entry: LedgerEntry): boolean {
  return (
    ctx.now().getTime() - Date.parse(entry.messageDate) >
    ctx.config.maxAgeHours * 3_600_000
  );
}

export function newEntry(message: Candidate, now: Date): LedgerEntry {
  return {
    messageId: message.id,
    fileName: message.document.fileName,
    size: message.document.size,
    uniqueId: message.document.uniqueId,
    messageDate: new Date(message.date * 1000).toISOString(),
    status: 'downloading',
    attempts: 0,
    sha256: null,
    localFile: null,
    nextAttemptAt: null,
    lastError: null,
    result: null,
    reportDir: null,
    firstSeenAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function moveInto(dir: string, file: string): void {
  if (existsSync(file)) renameSync(file, join(dir, basename(file)));
}
