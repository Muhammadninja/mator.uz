import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { privateTempDir } from '../../../../test/utils/dv-telegram-fakes';
import { Ledger, ledgerPath, LedgerError } from './ledger';
import {
  assertPrivateIfExists,
  assertPrivateStateDir,
  ensurePrivateDir,
  hasNulByte,
  InsecurePathError,
  isInside,
  safeFileName,
  writeFileAtomic,
} from './secure-fs';

const PROJECT = join(__dirname, '..', '..', '..', '..');

describe('Telegram ingest — state directory rules', () => {
  it('accepts a private directory outside the project', () => {
    expect(() =>
      assertPrivateStateDir(privateTempDir(), PROJECT),
    ).not.toThrow();
  });

  it('refuses a directory other users can read', () => {
    const dir = privateTempDir();
    chmodSync(dir, 0o755);
    expect(() => assertPrivateStateDir(dir, PROJECT)).toThrow(/chmod 700/);
  });

  it('refuses a missing directory and tells how to create it', () => {
    const dir = join(privateTempDir(), 'missing');
    expect(() => assertPrivateStateDir(dir, PROJECT)).toThrow(
      /install -d -m 0700/,
    );
  });

  it('refuses a relative path and a symlink', () => {
    expect(() => assertPrivateStateDir('state', PROJECT)).toThrow(
      InsecurePathError,
    );
    const root = privateTempDir();
    const target = join(root, 'real');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, 'link'));
    expect(() => assertPrivateStateDir(join(root, 'link'), PROJECT)).toThrow(
      /symlink/,
    );
  });

  it('refuses a directory inside the project or any repository / package', () => {
    const root = privateTempDir();
    const inProject = join(root, 'Backend', 'state');
    mkdirSync(inProject, { recursive: true, mode: 0o700 });
    expect(() =>
      assertPrivateStateDir(inProject, join(root, 'Backend')),
    ).toThrow(/inside the project/);

    const repo = privateTempDir();
    mkdirSync(join(repo, '.git'));
    const inRepo = join(repo, 'state');
    mkdirSync(inRepo, { mode: 0o700 });
    expect(() => assertPrivateStateDir(inRepo, PROJECT)).toThrow(
      /contains \.git/,
    );
  });

  it('checks the files it finds and tightens what it creates', () => {
    const dir = privateTempDir();
    const file = join(dir, 'td.binlog');
    writeFileSync(file, 'x', { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(() => assertPrivateIfExists(file)).toThrow(/chmod 600/);
    chmodSync(file, 0o600);
    expect(() => assertPrivateIfExists(file)).not.toThrow();
    expect(() => assertPrivateIfExists(join(dir, 'absent'))).not.toThrow();

    const sub = join(dir, 'inbox');
    mkdirSync(sub, { mode: 0o755 });
    chmodSync(sub, 0o755);
    ensurePrivateDir(sub);
    expect(statSync(sub).mode & 0o777).toBe(0o700);
  });

  it('writes atomically with mode 0600', () => {
    const path = join(privateTempDir(), 'ledger.json');
    writeFileAtomic(path, '{"a":1}');
    writeFileAtomic(path, '{"a":2}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('makes a Telegram file name safe for the disk', () => {
    expect(safeFileName('dv_parts_2026_10_18.txt')).toBe(
      'dv_parts_2026_10_18.txt',
    );
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\x.txt')).toBe('x.txt');
    expect(safeFileName('.hidden')).toBe('hidden');
    expect(safeFileName('прайс 18.10.txt')).toBe('______18.10.txt');
    expect(safeFileName('')).toBe('document');
  });

  it('detects binary content', () => {
    const dir = privateTempDir();
    writeFileSync(join(dir, 'text.txt'), 'code_1c\tname\r');
    writeFileSync(join(dir, 'bin.txt'), Buffer.from([0x50, 0x4b, 0x00, 0x03]));
    expect(hasNulByte(join(dir, 'text.txt'))).toBe(false);
    expect(hasNulByte(join(dir, 'bin.txt'))).toBe(true);
  });

  it('isInside compares path segments, not prefixes', () => {
    expect(isInside('/srv/app/state', '/srv/app')).toBe(true);
    expect(isInside('/srv/app', '/srv/app')).toBe(true);
    expect(isInside('/srv/app-state', '/srv/app')).toBe(false);
    expect(isInside('/var/lib/dv', '/srv/app')).toBe(false);
  });
});

describe('Telegram ingest — ledger', () => {
  const now = new Date('2026-10-18T09:00:00.000Z');
  const entry = {
    messageId: 10,
    fileName: 'dv_parts_1.txt',
    size: 10,
    uniqueId: 'u',
    messageDate: now.toISOString(),
    status: 'imported' as const,
    attempts: 1,
    sha256: 'abc',
    localFile: '10-dv_parts_1.txt',
    nextAttemptAt: null,
    lastError: null,
    result: null,
    reportDir: null,
    firstSeenAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  it('persists entries and the last import across loads', () => {
    const path = ledgerPath(privateTempDir(), 7);
    const ledger = Ledger.load(path, 7);
    ledger.put(entry, now);
    ledger.markImported(10, 'abc', now);
    const again = Ledger.load(path, 7);
    expect(again.get(10)).toMatchObject({ status: 'imported', sha256: 'abc' });
    expect(again.lastImported).toEqual({
      messageId: 10,
      sha256: 'abc',
      at: now.toISOString(),
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a corrupt ledger or one of another chat instead of starting over silently', () => {
    const dir = privateTempDir();
    writeFileSync(ledgerPath(dir, 7), '{oops');
    expect(() => Ledger.load(ledgerPath(dir, 7), 7)).toThrow(LedgerError);
    const other = ledgerPath(dir, 8);
    Ledger.load(other, 8).put(entry, now);
    expect(() => Ledger.load(other, 9)).toThrow(/for chat 9/);
  });

  it('prunes only finished entries older than the cutoff', () => {
    const ledger = Ledger.load(ledgerPath(privateTempDir(), 7), 7);
    const old = new Date('2026-08-01T00:00:00.000Z');
    ledger.put(entry, old);
    ledger.put({ ...entry, messageId: 11, status: 'retry' }, old);
    expect(ledger.prune(new Date('2026-09-01T00:00:00.000Z'))).toBe(1);
    expect(ledger.get(10)).toBeUndefined();
    expect(ledger.get(11)).toBeDefined();
  });
});
