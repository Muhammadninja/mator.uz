'use strict';

const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baselineGrowth, parseRenames, run } = require('./eslint-baseline-guard.cjs');

const s = (count) => ({ count });

test('a shrinking or unchanged baseline passes', () => {
  const base = { 'a.ts': { r1: s(3), r2: s(1) }, 'b.ts': { r1: s(1) } };
  assert.deepEqual(baselineGrowth(base, base), []);
  assert.deepEqual(baselineGrowth(base, { 'a.ts': { r1: s(2) } }), []);
  assert.deepEqual(baselineGrowth(base, {}), []);
});

test('a raised count, a new rule and a new file are all growth', () => {
  const base = { 'a.ts': { r1: s(3) } };
  const head = { 'a.ts': { r1: s(4), r2: s(1) }, 'new.ts': { r1: s(1) } };
  assert.deepEqual(baselineGrowth(base, head), [
    { file: 'a.ts', rule: 'r1', base: 3, head: 4 },
    { file: 'a.ts', rule: 'r2', base: 0, head: 1 },
    { file: 'new.ts', rule: 'r1', base: 0, head: 1 },
  ]);
});

test('a renamed file keeps the allowance of its old path, and no more', () => {
  const base = { 'old.ts': { r1: s(2) } };
  const renames = new Map([['moved.ts', 'old.ts']]);
  assert.deepEqual(baselineGrowth(base, { 'moved.ts': { r1: s(2) } }, renames), []);
  assert.deepEqual(baselineGrowth(base, { 'moved.ts': { r1: s(3) } }, renames), [
    { file: 'moved.ts', rule: 'r1', base: 2, head: 3 },
  ]);
});

test('parseRenames reads git --name-status output', () => {
  const out = 'R100\tsrc/a.ts\tsrc/b.ts\nM\tsrc/c.ts\nR087\tx.ts\ty/x.ts\n';
  assert.deepEqual(
    [...parseRenames(out)],
    [
      ['src/b.ts', 'src/a.ts'],
      ['y/x.ts', 'x.ts'],
    ],
  );
});

test('run() against a real git history: suppress-all in the PR fails, prune passes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'baseline-guard-'));
  const sh = (...args) =>
    execFileSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args], {
      cwd: dir,
      stdio: 'ignore',
    });
  const write = (obj) => writeFileSync(path.join(dir, 'eslint-suppressions.json'), JSON.stringify(obj));
  const silent = { log() {}, error() {} };
  try {
    sh('init', '-q');
    sh('commit', '-q', '--allow-empty', '-m', 'before the baseline existed');
    const beforeBaseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/old.ts'), 'export const x = 1;\n'.repeat(20));
    write({ 'src/old.ts': { r1: s(2) } });
    sh('add', '-A');
    sh('commit', '-qm', 'base');

    write({ 'src/old.ts': { r1: s(3) } }); // what --suppress-all would record
    assert.equal(run('HEAD', dir, silent), 1);

    write({ 'src/old.ts': { r1: s(1) } }); // what --prune-suppressions leaves
    assert.equal(run('HEAD', dir, silent), 0);

    renameSync(path.join(dir, 'src/old.ts'), path.join(dir, 'src/moved.ts'));
    write({ 'src/moved.ts': { r1: s(2) } });
    sh('add', '-A');
    sh('commit', '-qm', 'rename');
    assert.equal(run('HEAD~1', dir, silent), 0);

    write({ 'src/moved.ts': { r1: s(2) }, 'src/new.ts': { r1: s(1) } });
    assert.equal(run('HEAD~1', dir, silent), 1);

    assert.equal(run(beforeBaseline, dir, silent), 0); // the PR that introduces it
    assert.equal(run('does-not-exist', dir, silent), 2); // unfetched base never passes
    assert.equal(run('', dir, silent), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
