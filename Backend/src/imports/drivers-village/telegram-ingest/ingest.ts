/**
 * One pass of the Driver's Village Telegram ingest:
 *
 *   recent messages of the ONE allowed chat ─► filter (document-filter.ts)
 *     ─► for each accepted export, oldest first (process-export.ts):
 *          download → verify (size, text) → SHA-256
 *          → same content as the last import? → `duplicate`
 *          → the existing importer CLI (import-runner.ts) → ledger
 *
 * Order: exports are imported strictly in message order, and an export that
 * waits for a retry holds back the newer ones — an older export must never be
 * applied after a newer one, or older prices would overwrite newer prices.
 * An unfinished export is resumed from its local copy even when a history
 * answer misses its message; without a copy, newer exports wait until it is
 * listed again or becomes older than DV_TELEGRAM_MAX_AGE_HOURS (→ `failed`).
 *
 * Idempotency: the ledger records every accepted message; terminal entries are
 * never processed again, and the same content re-sent in a new message is not
 * re-imported. Re-running the importer on the same file is itself safe (it
 * resumes after a failed batch), so retries are always allowed.
 *
 * Retries: a transient failure (download, database, projection, timeout)
 * schedules the same export again after 10, 20, 40, 80 min, then every 2 h,
 * until DV_TELEGRAM_MAX_ATTEMPTS; then it is `failed` and kept in failed/.
 * A file the importer rejects outright (unreadable, wrong header) fails at
 * once. A busy import lock (a manual import) or a stop request is not counted.
 *
 * The caller holds the sync lock for the whole pass (scripts/…-sync.ts).
 */
import { lstatSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { IngestConfig } from './config';
import {
  evaluateMessage,
  type IncomingDocument,
  type IncomingMessage,
  type RejectReason,
} from './document-filter';
import {
  classifyImport,
  type ImportOutcome,
  type ImportRunner,
} from './import-runner';
import { isTerminal, Ledger } from './ledger';
import { errorMessage, type Logger } from './log';
import {
  downloadVerified,
  fail,
  hasLocalCopy,
  isExpired,
  localPath,
  newEntry,
  processExport,
  UnusableFileError,
  type Candidate,
  type IngestContext,
} from './process-export';
import { ensurePrivateDir, safeFileName } from './secure-fs';
import { statePaths } from './state-paths';

export interface DocumentSource {
  /** The newest messages of the configured chat, newest first. */
  listRecentMessages(limit: number): Promise<IncomingMessage[]>;
  /** Download the document into `destination`, which must not exist yet. */
  download(
    document: IncomingDocument,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type SyncMode = 'sync' | 'dry-run' | 'baseline';

export interface SyncDeps {
  config: IngestConfig;
  source: DocumentSource;
  runner: ImportRunner;
  log: Logger;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface SyncSummary {
  mode: SyncMode;
  scanned: number;
  accepted: number;
  skipped: Partial<Record<RejectReason, number>>;
  imported: number;
  duplicates: number;
  /** Marked `failed` in this pass — needs an operator. */
  failed: number;
  /** Not done yet: waiting for a retry or for a busy import lock. */
  waiting: number;
  baselined: number;
  dryRun: { messageId: number; outcome: ImportOutcome } | null;
}

export async function runSync(
  deps: SyncDeps,
  mode: SyncMode,
): Promise<SyncSummary> {
  const now = deps.now ?? (() => new Date());
  const paths = statePaths(deps.config.stateDir, deps.config.chatId);
  for (const dir of [paths.inbox, paths.archive, paths.failed, paths.reports])
    ensurePrivateDir(dir);
  const ctx: IngestContext = {
    ...deps,
    now,
    paths,
    ledger: Ledger.load(paths.ledger, deps.config.chatId),
  };
  const summary: SyncSummary = {
    mode,
    scanned: 0,
    accepted: 0,
    skipped: {},
    imported: 0,
    duplicates: 0,
    failed: 0,
    waiting: 0,
    baselined: 0,
    dryRun: null,
  };

  const messages = await deps.source.listRecentMessages(deps.config.scanLimit);
  summary.scanned = messages.length;
  const accepted: Candidate[] = [];
  for (const message of messages) {
    const verdict = evaluateMessage(message, deps.config, now().getTime());
    if (verdict.accept) {
      accepted.push(message as Candidate);
      continue;
    }
    summary.skipped[verdict.reason] =
      (summary.skipped[verdict.reason] ?? 0) + 1;
    if (message.document) {
      const quiet =
        verdict.reason === 'too_old' || verdict.reason === 'outgoing';
      deps.log[quiet ? 'debug' : 'info']('skipped a document', {
        messageId: message.id,
        fileName: message.document.fileName,
        reason: verdict.reason,
      });
    }
  }
  // Oldest first: by the time the message was sent, then by id.
  accepted.sort((a, b) => a.date - b.date || a.id - b.id);
  summary.accepted = accepted.length;

  if (mode === 'baseline') {
    for (const message of accepted) {
      if (ctx.ledger.get(message.id)) continue;
      ctx.ledger.put(
        {
          ...newEntry(message, now()),
          status: 'baseline',
          result: 'present when the ingest was set up; not imported',
        },
        now(),
      );
      summary.baselined += 1;
    }
    deps.log.info('baseline recorded', { baselined: summary.baselined });
    return summary;
  }
  if (mode === 'dry-run') {
    summary.dryRun = await dryRun(ctx, accepted);
    return summary;
  }

  removeLeftovers(paths.inbox, deps.log);
  // The queue: unfinished entries of earlier passes and new exports, oldest
  // first. An unfinished entry is resumed from its local copy even when its
  // message is missing from this listing (a short or empty history answer).
  const byId = new Map(accepted.map((m) => [m.id, m]));
  const sentAt = new Map<number, number>();
  for (const e of ctx.ledger.entries())
    if (!isTerminal(e.status))
      sentAt.set(e.messageId, Date.parse(e.messageDate) / 1000);
  for (const m of accepted) sentAt.set(m.id, m.date);
  const queue = [...sentAt.keys()].sort(
    (a, b) => sentAt.get(a)! - sentAt.get(b)! || a - b,
  );
  for (const id of queue) {
    if (deps.signal?.aborted) break;
    const entry = ctx.ledger.get(id);
    if (entry && isTerminal(entry.status)) continue;
    if (entry && isExpired(ctx, entry)) {
      fail(ctx, entry, localPath(ctx, entry), 'expired');
      summary.failed += 1;
      continue;
    }
    const message = byId.get(id) ?? null;
    if (!message && !(entry && hasLocalCopy(ctx, entry))) {
      // Nothing to resume from: wait until the message is listed again (or
      // expires) rather than import newer exports before it.
      deps.log.warn(
        'an unfinished export is missing from the recent chat history; newer exports wait behind it',
        { messageId: id, fileName: entry?.fileName },
      );
      summary.waiting += 1;
      break;
    }
    if (
      entry?.status === 'retry' &&
      entry.nextAttemptAt &&
      new Date(entry.nextAttemptAt) > now()
    ) {
      deps.log.info(
        'an earlier export waits for its retry; newer exports wait behind it',
        {
          messageId: entry.messageId,
          fileName: entry.fileName,
          nextAttemptAt: entry.nextAttemptAt,
          attempts: entry.attempts,
        },
      );
      summary.waiting += 1;
      break;
    }
    const step = await processExport(ctx, message, entry);
    if (step === 'imported') summary.imported += 1;
    else if (step === 'duplicate') summary.duplicates += 1;
    else if (step === 'failed') summary.failed += 1;
    else {
      summary.waiting += 1;
      break;
    }
  }
  prune(ctx);
  return summary;
}

/** The newest unfinished (else newest) export → importer --dry-run. */
async function dryRun(
  ctx: IngestContext,
  accepted: Candidate[],
): Promise<SyncSummary['dryRun']> {
  const pick =
    [...accepted].reverse().find((m) => {
      const status = ctx.ledger.get(m.id)?.status;
      return !status || !isTerminal(status);
    }) ?? accepted[accepted.length - 1];
  if (!pick) {
    ctx.log.info('dry run: no message in the chat passes the filter');
    return null;
  }
  ensurePrivateDir(ctx.paths.dryRun);
  const file = join(
    ctx.paths.dryRun,
    `${pick.id}-${safeFileName(pick.document.fileName)}`,
  );
  try {
    rmSync(file, { force: true });
    await downloadVerified(ctx, pick.document, file);
    const reportDir = join(
      ctx.paths.reports,
      `dry-run-${pick.id}-${ctx.now().toISOString().replace(/[:.]/g, '-')}`,
    );
    ctx.log.info('dry run: running the importer with --dry-run', {
      messageId: pick.id,
      fileName: pick.document.fileName,
    });
    const result = await ctx.runner.run({
      file,
      reportDir,
      dryRun: true,
      timeoutMs: ctx.config.importTimeoutMs,
      signal: ctx.signal,
    });
    const outcome = classifyImport(result);
    ctx.log.info('dry run finished; nothing was recorded or written', {
      messageId: pick.id,
      exitCode: result.exitCode,
      outcome: outcome.kind,
      detail: outcome.detail,
      report: result.reportPath,
    });
    return { messageId: pick.id, outcome };
  } catch (error) {
    const outcome: ImportOutcome = {
      kind: error instanceof UnusableFileError ? 'rejected' : 'retry',
      detail: errorMessage(error),
    };
    ctx.log.warn('dry run: the export could not be checked', {
      messageId: pick.id,
      detail: outcome.detail,
    });
    return { messageId: pick.id, outcome };
  } finally {
    rmSync(file, { force: true });
  }
}

/** Partial downloads of an interrupted run. */
function removeLeftovers(inbox: string, log: Logger): void {
  for (const name of readdirSync(inbox)) {
    if (!name.endsWith('.part')) continue;
    rmSync(join(inbox, name), { force: true });
    log.debug('removed an interrupted download', { file: name });
  }
}

/** Retention: old ledger entries, archived/failed files and reports. */
function prune(ctx: IngestContext): void {
  const cutoff = ctx.now().getTime() - ctx.config.retentionDays * 86_400_000;
  ctx.ledger.prune(new Date(cutoff));
  for (const dir of [ctx.paths.archive, ctx.paths.failed, ctx.paths.reports]) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).mtimeMs < cutoff)
        rmSync(path, { recursive: true, force: true });
    }
  }
}
