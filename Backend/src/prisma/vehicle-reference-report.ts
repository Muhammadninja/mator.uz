import { REFERENCE_KNOWN_ISSUES } from './seed-data/vehicle-reference.seed';
import { isBlocked, isNoop, ReferencePlan } from './vehicle-reference-plan';

export type ReferenceSeedOutcome = 'dry-run' | 'applied' | 'blocked';

/**
 * The seed's printed summary. Each kind of change gets its own section so a
 * reviewer can check the dry-run line by line before anyone passes --apply.
 */
export function formatVehicleReferenceReport(
  plan: ReferencePlan,
  opts: { outcome: ReferenceSeedOutcome; target: string },
): string {
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    out.push('', title);
    out.push(...(lines.length > 0 ? lines.map((l) => `  ${l}`) : ['  (none)']));
  };

  out.push(
    opts.outcome === 'dry-run'
      ? 'G-2 vehicle reference seed: DRY-RUN, nothing is written (pass --apply to write)'
      : 'G-2 vehicle reference seed: APPLY',
    `Target: ${opts.target}`,
  );

  section(
    `Already present, unchanged (${plan.unchangedMakes.length} makes, ${plan.unchangedModels.length} models)`,
    [
      ...plan.unchangedMakes.map((id) => `= make ${id}`),
      ...plan.unchangedModels.map((id) => `= model ${id}`),
    ],
  );
  section(
    `New makes (${plan.newMakes.length}): created active, not "coming soon"`,
    plan.newMakes.map(
      (m) =>
        `+ ${m.id.padEnd(16)} ${m.name.padEnd(14)} sort ${String(m.sortOrder).padEnd(4)} ${m.evidence}`,
    ),
  );
  section(
    `New models (${plan.newModels.length}): appended after each make's existing models`,
    plan.newModels.map(
      (m) =>
        `+ ${m.makeId.padEnd(11)} ${m.id.padEnd(16)} ${m.name.padEnd(14)} sort ${String(m.sortOrder).padEnd(4)} ${m.evidence}`,
    ),
  );
  section(`Explicit make-state changes (${plan.stateChanges.length})`, [
    ...plan.stateChanges.map(
      (c) =>
        `~ ${c.makeId.padEnd(16)} is_active ${c.from} → ${c.to}   ${c.reason}`,
    ),
    ...plan.stateUnchanged.map(
      (id) => `= ${id.padEnd(16)} already in the planned state; nothing to do`,
    ),
  ]);
  section(
    `Conflicts needing a manual migration (${plan.conflicts.length}): BLOCKING`,
    plan.conflicts.map((c) => `! ${c}`),
  );
  section(
    `Errors (${plan.errors.length}): BLOCKING`,
    plan.errors.map((e) => `✗ ${e}`),
  );
  section(
    'Known issues left for separate migrations (not changed by this seed)',
    [
      ...REFERENCE_KNOWN_ISSUES.map((i) => `- ${i}`),
      ...plan.duplicateNames.map(
        (d) => `- in the database now, same name twice: ${d}`,
      ),
    ],
  );

  out.push(
    '',
    `Preserved: ${plan.untouched.makes} makes and ${plan.untouched.models} models outside the dataset are never written.`,
    '',
    `Summary: +${plan.newMakes.length} makes, +${plan.newModels.length} models, ` +
      `${plan.stateChanges.length} make-state change(s), ` +
      `${plan.unchangedMakes.length + plan.unchangedModels.length + plan.stateUnchanged.length} unchanged, ` +
      `${plan.conflicts.length} conflict(s), ${plan.errors.length} error(s)`,
    `Result: ${resultLine(plan, opts.outcome)}`,
  );
  return out.join('\n');
}

function resultLine(
  plan: ReferencePlan,
  outcome: ReferenceSeedOutcome,
): string {
  if (isBlocked(plan)) {
    return 'BLOCKED. Nothing was written. Resolve the conflicts/errors above first.';
  }
  if (outcome === 'blocked') {
    return 'ROLLED BACK. Nothing was written; see the error printed below.';
  }
  if (isNoop(plan))
    return 'nothing to do; the database already matches the dataset.';
  if (outcome === 'dry-run')
    return 'dry-run OK. Review every line above, then re-run with --apply.';
  return 'APPLIED in one transaction. Post-write check passed: every pre-existing row is unchanged.';
}
