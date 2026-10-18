/**
 * The runner starts the importer CLI as a child process. These specs never
 * start the real CLI (it would open the database in DATABASE_URL): a tiny
 * stand-in script plays the importer, steered by the content of its input.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  MemoryLogger,
  privateTempDir,
  reportStub,
} from '../../../../test/utils/dv-telegram-fakes';
import {
  classifyImport,
  CliImportRunner,
  defaultImporterCommand,
  IMPORT_CLI_SCRIPT,
  importerEnv,
  TS_NODE_COMPILER_OPTIONS,
  type ImportRunResult,
} from './import-runner';

const PROJECT = join(__dirname, '..', '..', '..', '..');

/** Behaves like the CLI: args <file> --report-dir=<dir> [--dry-run]. */
const FAKE_IMPORTER = `
const fs = require('fs');
const path = require('path');
const [file, ...flags] = process.argv.slice(2);
const reportDir = flags.find((f) => f.startsWith('--report-dir=')).slice('--report-dir='.length);
const dryRun = flags.includes('--dry-run');
const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('args ' + JSON.stringify({ file: path.basename(file), dryRun }));
console.log('hash=' + (process.env.DV_TELEGRAM_API_HASH || 'absent') + ' db=' + (process.env.DATABASE_URL ? 'inherited' : 'absent'));
console.error('a warning line');
if (plan.report) {
  fs.writeFileSync(path.join(reportDir, 'drivers-village-' + (dryRun ? 'dry-run' : 'import') + '-2026-10-18T09-00-00-000Z.json'), JSON.stringify(plan.report));
}
setTimeout(() => process.exit(plan.exit), plan.sleepMs || 0);
`;

function setup(env: NodeJS.ProcessEnv = {}) {
  const dir = privateTempDir();
  const script = join(dir, 'fake-importer.js');
  writeFileSync(script, FAKE_IMPORTER);
  const log = new MemoryLogger();
  const runner = new CliImportRunner(
    { file: process.execPath, args: [script], cwd: dir },
    log,
    env,
  );
  const run = (
    plan: object,
    opts: { dryRun?: boolean; timeoutMs?: number } = {},
  ) => {
    const file = join(dir, `export-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(file, JSON.stringify(plan));
    return runner.run({
      file,
      reportDir: join(dir, 'reports', String(Math.random()).slice(2)),
      dryRun: opts.dryRun ?? false,
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
  };
  return { log, run };
}

function result(patch: Partial<ImportRunResult>): ImportRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    spawnError: null,
    report: reportStub(),
    reportPath: '/r.json',
    ...patch,
  };
}

describe('Telegram ingest — running the existing importer CLI', () => {
  it('passes the file, the report directory and --dry-run, and reads the report', async () => {
    const { log, run } = setup({ PATH: process.env.PATH });
    const res = await run(
      { exit: 2, report: reportStub({ summary: { rejectedRows: 4 } }) },
      { dryRun: true },
    );
    expect(res.exitCode).toBe(2);
    expect(res.report?.summary.rejectedRows).toBe(4);
    expect(res.reportPath).toMatch(/drivers-village-dry-run-.*\.json$/);
    expect(log.text()).toContain('importer: args {"file":"export-');
    expect(log.text()).toContain('"dryRun":true');
    expect(
      log.lines.find((l) => l.message === 'importer: a warning line')?.level,
    ).toBe('warn');
  });

  it('does not hand the Telegram settings to the importer, but keeps the rest of the environment', async () => {
    const { log, run } = setup({
      DV_TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef',
      DV_TELEGRAM_STATE_DIR: '/var/lib/dv',
      DATABASE_URL: 'postgresql://example.invalid/db',
    });
    await run({ exit: 0, report: reportStub() });
    expect(log.text()).toContain('hash=absent db=inherited');
    expect(
      importerEnv({ DV_TELEGRAM_X: '1', DV_IMPORT_LOCK_FILE: '/l', A: 'b' }),
    ).toEqual({
      DV_IMPORT_LOCK_FILE: '/l',
      A: 'b',
    });
  });

  it('stops an importer that exceeds the time limit', async () => {
    const { run } = setup();
    const res = await run({ exit: 0, sleepMs: 60_000 }, { timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.signal).toBe('SIGTERM');
    expect(classifyImport(res).kind).toBe('retry');
  });

  it('reports an importer that cannot be started as a retry', async () => {
    const runner = new CliImportRunner(
      {
        file: join(privateTempDir(), 'no-such-node'),
        args: [],
        cwd: privateTempDir(),
      },
      new MemoryLogger(),
      {},
    );
    const res = await runner.run({
      file: '/nonexistent.txt',
      reportDir: join(privateTempDir(), 'r'),
      dryRun: false,
      timeoutMs: 20_000,
    });
    expect(res.spawnError).toContain('ENOENT');
    expect(classifyImport(res)).toMatchObject({ kind: 'retry' });
  });

  it('reports a missing report as a retry, never as success', async () => {
    const { run } = setup();
    const res = await run({ exit: 0 });
    expect(res.report).toBeNull();
    expect(classifyImport(res)).toMatchObject({ kind: 'retry' });
  });

  it('runs the importer exactly like `npm run import:drivers-village`', () => {
    const pkg = JSON.parse(
      readFileSync(join(PROJECT, 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['import:drivers-village']).toBe(
      `ts-node --compiler-options '${TS_NODE_COMPILER_OPTIONS}' ${IMPORT_CLI_SCRIPT}`,
    );
    const command = defaultImporterCommand(PROJECT);
    expect(command.file).toBe(process.execPath);
    expect(command.cwd).toBe(PROJECT);
    expect(command.args[0]).toBe(require.resolve('ts-node/dist/bin.js'));
    expect(command.args.slice(1)).toEqual([
      '--compiler-options',
      TS_NODE_COMPILER_OPTIONS,
      IMPORT_CLI_SCRIPT,
    ]);
  });
});

describe('Telegram ingest — what an importer result means', () => {
  it.each<[string, Partial<ImportRunResult>, string]>([
    ['clean import', {}, 'imported'],
    [
      'rejected rows only (exit 2)',
      { exitCode: 2, report: reportStub({ summary: { rejectedRows: 7 } }) },
      'imported',
    ],
    [
      'projection failures (exit 2)',
      {
        exitCode: 2,
        report: reportStub({
          summary: {
            written: {
              created: 1,
              updated: 0,
              skippedUnchanged: 0,
              projected: 0,
              projectionFailures: 1,
            },
          },
        }),
      },
      'retry',
    ],
    [
      'another import holds the lock (exit 3)',
      { exitCode: 3, report: null },
      'busy',
    ],
    [
      'a failed batch (aborted while writing)',
      {
        exitCode: 1,
        report: reportStub({
          meta: {
            aborted: true,
            abortReason: 'Batch starting at position 101 failed',
          },
        }),
      },
      'retry',
    ],
    [
      'a setup problem in the database',
      {
        exitCode: 1,
        report: reportStub({
          meta: {
            aborted: true,
            abortReason: 'Setup error — nothing was written',
          },
          summary: { written: null },
          environmentErrors: ['no supply-side seller is linked'],
        }),
      },
      'retry',
    ],
    [
      'an unreadable file / wrong header',
      {
        exitCode: 1,
        report: reportStub({
          meta: {
            aborted: true,
            abortReason: 'Header problems: Missing required column: code_1c',
          },
          summary: { written: null },
        }),
      },
      'rejected',
    ],
    ['a crash before any report', { exitCode: 1, report: null }, 'retry'],
    ['killed', { exitCode: null, signal: 'SIGKILL', report: null }, 'retry'],
    [
      'could not start',
      { exitCode: null, spawnError: 'ENOENT', report: null },
      'retry',
    ],
  ])('%s → %s', (_case, patch, kind) => {
    expect(classifyImport(result(patch)).kind).toBe(kind);
  });

  it('keeps the importer’s reason for a rejected file', () => {
    const outcome = classifyImport(
      result({
        exitCode: 1,
        report: reportStub({
          meta: {
            aborted: true,
            abortReason: 'Header problems: Missing required column: code_1c',
          },
          summary: { written: null },
        }),
      }),
    );
    expect(outcome.detail).toContain('Missing required column: code_1c');
  });
});
