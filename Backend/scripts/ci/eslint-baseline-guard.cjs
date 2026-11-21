'use strict';

// CI guard for eslint-suppressions.json: a pull request may shrink the recorded
// lint debt but never grow it. Without this, `eslint --suppress-all` (or a hand
// edit) in the same PR would record the PR's own new errors and turn CI green.
//
// Usage, from Backend/:  node scripts/ci/eslint-baseline-guard.cjs <base-ref>
// Compares ./eslint-suppressions.json in the working tree with the same file
// at <base-ref>. A file renamed in the PR keeps the allowance of its old path.

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const BASELINE = 'eslint-suppressions.json';

/**
 * Every (file, rule) whose suppressed count is higher in `head` than in
 * `base`. `renames` maps a new path to the path it had in `base`.
 */
function baselineGrowth(base, head, renames = new Map()) {
  const growth = [];
  for (const [file, rules] of Object.entries(head)) {
    const allowed = base[renames.get(file) ?? file] ?? {};
    for (const [rule, { count }] of Object.entries(rules)) {
      const was = allowed[rule]?.count ?? 0;
      if (count > was) growth.push({ file, rule, base: was, head: count });
    }
  }
  return growth;
}

/** `R<score>\told\tnew` lines of `git diff --name-status` → Map(new → old). */
function parseRenames(nameStatus) {
  const renames = new Map();
  for (const line of nameStatus.split('\n')) {
    const [status, from, to] = line.split('\t');
    if (status?.startsWith('R') && from && to) renames.set(to, from);
  }
  return renames;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Returns the process exit code; prints its findings. */
function run(baseRef, cwd = process.cwd(), log = console) {
  if (!baseRef) {
    log.error('usage: eslint-baseline-guard.cjs <base-ref>');
    return 2;
  }
  try {
    git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], cwd);
  } catch {
    // A failed fetch must fail the check, not read as "no baseline at base".
    log.error(`base ref ${baseRef} is not available; fetch it first.`);
    return 2;
  }
  let baseText;
  try {
    baseText = git(['show', `${baseRef}:./${BASELINE}`], cwd);
  } catch {
    // Only the PR that introduces the baseline gets here; review it by hand.
    log.log(`${BASELINE} does not exist at ${baseRef}: nothing to compare with.`);
    return 0;
  }
  const base = JSON.parse(baseText);
  const head = JSON.parse(readFileSync(`${cwd}/${BASELINE}`, 'utf8'));
  const renames = parseRenames(
    git(['diff', '--relative', '-M', '--name-status', '--diff-filter=R', baseRef, 'HEAD'], cwd),
  );

  const growth = baselineGrowth(base, head, renames);
  if (growth.length === 0) {
    log.log(`${BASELINE}: no suppression added or raised.`);
    return 0;
  }
  log.error(
    `${BASELINE} may only shrink. This change adds or raises suppressions,` +
      ' which would hide new lint errors. Fix the errors instead:',
  );
  for (const g of growth) log.error(`  ${g.file}  ${g.rule}: ${g.base} -> ${g.head}`);
  return 1;
}

module.exports = { baselineGrowth, parseRenames, run };

if (require.main === module) process.exit(run(process.argv[2]));
