import { spawn } from 'child_process';
import {
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { privateTempDir } from '../../../test/utils/dv-telegram-fakes';
import {
  acquireLock,
  DEFAULT_IMPORT_LOCK_FILE,
  importLockPath,
  LockBusyError,
  readLockInfo,
  type LockInfo,
  type ProcessProbe,
} from './import-lock';

const holderFile = (path: string, patch: Partial<LockInfo>) =>
  writeFileSync(
    path,
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      label: 'holder',
      startedAt: '2026-10-18T08:00:00.000Z',
      bootId: null,
      processStart: null,
      ...patch,
    }),
  );

const probe = (over: Partial<ProcessProbe>): ProcessProbe => ({
  bootId: () => 'boot-now',
  processStart: () => '1000',
  isAlive: () => true,
  ...over,
});

/** The lock module as plain JS, for real child processes. */
function compiledLockModule(): string {
  const dir = privateTempDir('dv-lock-js-');
  const out = ts.transpileModule(
    readFileSync(join(__dirname, 'import-lock.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  writeFileSync(join(dir, 'import-lock.js'), out);
  writeFileSync(
    join(dir, 'child.js'),
    `const { acquireLock } = require('./import-lock.js');
const [path, startAt, holdMs, mode] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
try {
  const lock = acquireLock(path, { label: 'child ' + process.pid });
  process.stdout.write('acquired');
  if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
  setTimeout(() => { lock.release(); }, Number(holdMs));
} catch (e) {
  process.stdout.write(e.name);
}`,
  );
  return join(dir, 'child.js');
}

function runChild(
  child: string,
  args: string[],
): Promise<{ out: string; pid: number; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [child, ...args]);
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', (_code, signal) => resolve({ out, pid: p.pid!, signal }));
  });
}

describe('import lock', () => {
  it('is exclusive while held, complete from the start, and free again after release', () => {
    const path = join(privateTempDir(), 'import.lock');
    const lock = acquireLock(path, { label: 'first' });
    expect(readLockInfo(path)).toMatchObject({
      pid: process.pid,
      hostname: hostname(),
      label: 'first',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => acquireLock(path, { label: 'second' })).toThrow(LockBusyError);

    lock.release();
    expect(existsSync(path)).toBe(false);
    lock.release(); // idempotent
    acquireLock(path, { label: 'third' }).release();
  });

  it('two runs started at the same moment: exactly one gets the lock', async () => {
    const child = compiledLockModule();
    const path = join(privateTempDir(), 'import.lock');
    const startAt = String(Date.now() + 800);
    const results = await Promise.all([
      runChild(child, [path, startAt, '1500']),
      runChild(child, [path, startAt, '1500']),
    ]);
    expect(results.map((r) => r.out).sort()).toEqual([
      'LockBusyError',
      'acquired',
    ]);
    expect(existsSync(path)).toBe(false); // the winner released it
  }, 20_000);

  it('a holder killed with SIGKILL leaves its lock, and the next run replaces it', async () => {
    const child = compiledLockModule();
    const path = join(privateTempDir(), 'import.lock');
    const crashed = await runChild(child, [path, '0', '0', 'crash']);
    expect(crashed).toMatchObject({ out: 'acquired', signal: 'SIGKILL' });
    expect(readLockInfo(path)?.pid).toBe(crashed.pid);

    const lock = acquireLock(path, { label: 'after the crash' });
    expect(readLockInfo(path)).toMatchObject({
      pid: process.pid,
      label: 'after the crash',
    });
    lock.release();
  }, 20_000);

  it('never takes over a live holder because of age, however old the lock is', () => {
    const path = join(privateTempDir(), 'import.lock');
    holderFile(path, { startedAt: '2000-01-01T00:00:00.000Z' });
    const ancient = new Date('2000-01-01T00:00:00.000Z');
    utimesSync(path, ancient, ancient);
    expect(() => acquireLock(path, { label: 'x' })).toThrow(LockBusyError);
    expect(readLockInfo(path)?.label).toBe('holder');
  });

  it.each<[string, Partial<LockInfo>, Partial<ProcessProbe>]>([
    ['its process is gone', {}, { isAlive: () => false }],
    ['it was taken before the last reboot', { bootId: 'boot-before' }, {}],
    ['its pid now belongs to another process', { processStart: '999' }, {}],
  ])('replaces a lock when %s', (_why, lockPatch, probePatch) => {
    const path = join(privateTempDir(), 'import.lock');
    holderFile(path, {
      bootId: 'boot-now',
      processStart: '1000',
      ...lockPatch,
    });
    const lock = acquireLock(path, { label: 'next', probe: probe(probePatch) });
    expect(readLockInfo(path)?.label).toBe('next');
    lock.release();
  });

  it('keeps a lock whose live holder matches pid, boot and start time', () => {
    const path = join(privateTempDir(), 'import.lock');
    holderFile(path, { bootId: 'boot-now', processStart: '1000' });
    expect(() => acquireLock(path, { label: 'x', probe: probe({}) })).toThrow(
      LockBusyError,
    );
  });

  it('never removes a lock from another host or one it cannot read — the error says what to do', () => {
    const path = join(privateTempDir(), 'import.lock');
    holderFile(path, { hostname: 'other-host', pid: 1 });
    expect(() =>
      acquireLock(path, { label: 'x', probe: probe({ isAlive: () => false }) }),
    ).toThrow(/another host.*remove the file by hand/);
    writeFileSync(path, '{not json');
    expect(() => acquireLock(path, { label: 'x' })).toThrow(
      /cannot be read.*remove it by hand/,
    );
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });

  it('release never removes a lock that is no longer its own', () => {
    const path = join(privateTempDir(), 'import.lock');
    const lock = acquireLock(path, { label: 'mine' });
    holderFile(path, {
      label: 'theirs',
      startedAt: '2099-01-01T00:00:00.000Z',
    });
    const theirs = readFileSync(path, 'utf8');
    lock.release();
    expect(readFileSync(path, 'utf8')).toBe(theirs);
  });

  it('defaults to one host-wide path, overridable with DV_IMPORT_LOCK_FILE', () => {
    expect(importLockPath({})).toBe(DEFAULT_IMPORT_LOCK_FILE);
    expect(importLockPath({ DV_IMPORT_LOCK_FILE: ' /run/lock/dv.lock ' })).toBe(
      '/run/lock/dv.lock',
    );
  });
});
