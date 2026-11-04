/**
 * Runs the EXISTING importer — the CLI scripts/import-drivers-village.ts, the
 * same command an operator runs by hand (`npm run import:drivers-village`) —
 * on a downloaded export, as a child process. The ingest has no import logic
 * of its own: parsing, the code_1c → part-number rule, the highest valid price
 * per repeated code_1c, batching and projection all stay in that one importer.
 *
 * The child inherits the environment (the importer's Prisma client reads
 * DATABASE_URL from it or from Backend/.env) minus every DV_TELEGRAM_*
 * variable, which it has no use for. Its output is forwarded to the ingest
 * log line by line. The outcome is read from its exit code and its JSON
 * report (--report-dir is a fresh directory per run).
 */
import { spawn } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { LOCK_BUSY_EXIT_CODE } from '../import-lock';
import type { ImportReport } from '../drivers-village.report';
import { errorMessage, type Logger } from './log';
import { ensurePrivateDir } from './secure-fs';

/** The importer CLI and the ts-node options of `npm run import:drivers-village`. */
export const IMPORT_CLI_SCRIPT = 'scripts/import-drivers-village.ts';
export const TS_NODE_COMPILER_OPTIONS = '{"module":"commonjs"}';

/** Exit codes of the importer CLI (see its header comment). */
export const IMPORT_EXIT = {
  ok: 0,
  aborted: 1,
  finishedWithIssues: 2,
  lockBusy: LOCK_BUSY_EXIT_CODE,
} as const;

export interface ImporterCommand {
  file: string;
  args: string[];
  cwd: string;
}

/** `ts-node --compiler-options '{"module":"commonjs"}' scripts/import-drivers-village.ts`, run by this Node. */
export function defaultImporterCommand(projectRoot: string): ImporterCommand {
  return {
    file: process.execPath,
    args: [
      require.resolve('ts-node/dist/bin.js', { paths: [projectRoot] }),
      '--compiler-options',
      TS_NODE_COMPILER_OPTIONS,
      IMPORT_CLI_SCRIPT,
    ],
    cwd: projectRoot,
  };
}

export interface ImportRequest {
  file: string;
  reportDir: string;
  dryRun: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ImportRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** Spawn failure (the importer could not be started). */
  spawnError: string | null;
  report: ImportReport | null;
  reportPath: string | null;
}

export interface ImportRunner {
  run(request: ImportRequest): Promise<ImportRunResult>;
}

/** Grace period between SIGTERM and SIGKILL for a stopped importer. */
const KILL_GRACE_MS = 15_000;
const MAX_LOGGED_LINE = 2_000;

export class CliImportRunner implements ImportRunner {
  constructor(
    private readonly command: ImporterCommand,
    private readonly log: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  run(request: ImportRequest): Promise<ImportRunResult> {
    ensurePrivateDir(request.reportDir);
    const args = [
      ...this.command.args,
      request.file,
      `--report-dir=${request.reportDir}`,
      ...(request.dryRun ? ['--dry-run'] : []),
    ];
    return new Promise((resolve) => {
      let timedOut = false;
      let aborted = false;
      let spawnError: string | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      const child = spawn(this.command.file, args, {
        cwd: this.command.cwd,
        env: importerEnv(this.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stop = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        this.log.error('importer exceeded the time limit; stopping it', {
          timeoutMs: request.timeoutMs,
        });
        stop();
      }, request.timeoutMs);
      const onAbort = () => {
        aborted = true;
        this.log.warn('stop requested; stopping the importer');
        stop();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      forwardLines(child.stdout, (line) => this.log.info(`importer: ${line}`));
      forwardLines(child.stderr, (line) => this.log.warn(`importer: ${line}`));
      let settled = false;
      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener('abort', onAbort);
        const found = findReport(request.reportDir, request.dryRun);
        resolve({
          exitCode,
          signal,
          timedOut,
          aborted,
          spawnError,
          report: found?.report ?? null,
          reportPath: found?.path ?? null,
        });
      };
      child.on('error', (error) => {
        spawnError = errorMessage(error);
        // Never started: 'close' may not follow.
        if (child.pid === undefined) finish(null, null);
      });
      child.on('close', finish);
    });
  }
}

/** The environment for the importer: everything except DV_TELEGRAM_*. */
export function importerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('DV_TELEGRAM_')),
  );
}

export function findReport(
  dir: string,
  dryRun: boolean,
): { report: ImportReport; path: string } | null {
  const prefix = `drivers-village-${dryRun ? 'dry-run' : 'import'}-`;
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
      .sort();
  } catch {
    return null;
  }
  const name = names.pop();
  if (!name) return null;
  const path = join(dir, name);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isImportReport(parsed) ? { report: parsed, path } : null;
  } catch {
    return null;
  }
}

function isImportReport(value: unknown): value is ImportReport {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<Record<keyof ImportReport, unknown>>;
  const meta = r.meta as Partial<ImportReport['meta']> | undefined;
  const env = r.environment as Partial<ImportReport['environment']> | undefined;
  return (
    typeof meta === 'object' &&
    meta !== null &&
    typeof meta.aborted === 'boolean' &&
    typeof r.summary === 'object' &&
    r.summary !== null &&
    typeof env === 'object' &&
    env !== null &&
    Array.isArray(env.issues)
  );
}

export type ImportOutcome =
  /** Done; rejected rows (data errors) are in the report, not retried. */
  | { kind: 'imported'; detail: string }
  /** Transient or resumable: run the same file again later. */
  | { kind: 'retry'; detail: string }
  /** The file itself cannot be imported (unreadable, header, limits). */
  | { kind: 'rejected'; detail: string }
  /** Another import holds the import lock; nothing was done. */
  | { kind: 'busy'; detail: string };

/**
 * Exit code + report → what the ingest does next. Re-running a file is safe:
 * the importer is idempotent and resumes after a failed batch (committed rows
 * plan as unchanged, missing projections are redone).
 */
export function classifyImport(result: ImportRunResult): ImportOutcome {
  const { exitCode, report } = result;
  if (result.spawnError)
    return {
      kind: 'retry',
      detail: `the importer could not be started: ${result.spawnError}`,
    };
  if (result.aborted)
    return {
      kind: 'retry',
      detail: 'the ingest was stopped while the importer ran',
    };
  if (result.timedOut)
    return {
      kind: 'retry',
      detail: 'the importer exceeded the time limit and was stopped',
    };
  if (exitCode === IMPORT_EXIT.lockBusy)
    return {
      kind: 'busy',
      detail: 'another Driver’s Village import is running',
    };

  if (
    exitCode === IMPORT_EXIT.ok ||
    exitCode === IMPORT_EXIT.finishedWithIssues
  ) {
    if (!report || report.meta.aborted)
      return {
        kind: 'retry',
        detail: `the importer exited ${exitCode} without a usable report`,
      };
    const failures = report.summary.written?.projectionFailures ?? 0;
    if (failures > 0)
      return {
        kind: 'retry',
        detail: `${failures} catalog projection(s) failed; a re-run re-projects them (${describeReport(report)})`,
      };
    return { kind: 'imported', detail: describeReport(report) };
  }

  if (exitCode === IMPORT_EXIT.aborted && report?.meta.aborted) {
    const reason = truncate(report.meta.abortReason ?? 'no reason given');
    if (report.summary.written)
      return {
        kind: 'retry',
        detail: `aborted while writing; re-running resumes: ${reason}`,
      };
    if (report.environment.issues.some((i) => i.severity === 'error'))
      return {
        kind: 'retry',
        detail: `setup problem in the database, nothing written: ${reason}`,
      };
    return {
      kind: 'rejected',
      detail: `the file was not imported, nothing written: ${reason}`,
    };
  }

  return {
    kind: 'retry',
    detail: result.signal
      ? `the importer was killed by ${result.signal}`
      : `the importer exited ${exitCode} without a usable report (see the log lines above)`,
  };
}

/** One line of counts for the log and the ledger. */
export function describeReport(report: ImportReport): string {
  const s = report.summary;
  const parts = [
    `rows ${s.totalRows}`,
    `create ${s.rowsToCreate}`,
    `update ${s.rowsToUpdate}`,
    `unchanged ${s.rowsUnchanged}`,
    `rejected ${s.rejectedRows}`,
    `merged duplicates ${s.rowsMerged}`,
  ];
  if (s.rowsToCreateWithSharedKey)
    parts.push(
      `new positions sharing an 8-digit key ${s.rowsToCreateWithSharedKey}` +
        (s.rowsWithPossibleRename
          ? ` (${s.rowsWithPossibleRename} possibly renamed in 1C — review)`
          : ''),
    );
  if (s.written)
    parts.push(
      `written: created ${s.written.created}, updated ${s.written.updated}, projected ${s.written.projected}, projection failures ${s.written.projectionFailures}`,
    );
  return parts.join(', ');
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function forwardLines(
  stream: NodeJS.ReadableStream,
  emit: (line: string) => void,
): void {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines)
      if (line.trim()) emit(line.slice(0, MAX_LOGGED_LINE));
  });
  stream.on('end', () => {
    if (buffered.trim()) emit(buffered.slice(0, MAX_LOGGED_LINE));
  });
}
