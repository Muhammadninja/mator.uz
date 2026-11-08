import { createHash } from 'node:crypto';

/**
 * The gate every destructive maintenance script runs behind.
 *
 *   npm run <script>                                   # dry run: prints the plan, writes nothing
 *   npm run <script> -- --apply --confirm=<code>       # applies exactly that plan
 *   ... --allow-database=<host/db>                     # also needed for any non-local database
 *
 * The code is a hash of the script, the database and the plan, recomputed from the
 * database at apply time. A plan that changed, or one reviewed against another
 * database, does not confirm. NODE_ENV proves nothing about where DATABASE_URL points,
 * so only a loopback host outside production counts as local: every other host,
 * known or not, has to be named by hand.
 */

export class MaintenanceRefusal extends Error {}

export interface MaintenanceFlags {
  apply: boolean;
  confirm?: string;
  allowDatabase?: string;
}

export interface MaintenancePlan {
  /** One line each: what will be changed, for a person to read. */
  summary: string[];
  /** Everything the run will change. Must not hold timestamps taken now. */
  items: readonly unknown[];
}

export interface MaintenanceRun {
  script: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Read-only. */
  buildPlan: () => Promise<MaintenancePlan>;
  apply: () => Promise<void>;
}

export type MaintenanceOutcome = 'dry_run' | 'nothing_to_do' | 'applied';

const SHOWN_ITEMS = 20;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function parseMaintenanceFlags(
  argv: readonly string[],
): MaintenanceFlags {
  const flags: MaintenanceFlags = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') flags.apply = true;
    else if (arg.startsWith('--confirm=')) flags.confirm = arg.slice(10).trim();
    else if (arg.startsWith('--allow-database='))
      flags.allowDatabase = arg.slice('--allow-database='.length).trim();
  }
  return flags;
}

/** Host and database name only: never the user, password or query string. */
export function describeDatabase(env: NodeJS.ProcessEnv): {
  label: string;
  local: boolean;
} {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw new MaintenanceRefusal(
      'DATABASE_URL is not set or cannot be parsed, so the target is unknown. Nothing was done.',
    );
  }
  const database = url.pathname.replace(/^\//, '');
  if (!url.hostname || !database) {
    throw new MaintenanceRefusal(
      'DATABASE_URL names no host or database, so the target is unknown. Nothing was done.',
    );
  }
  return {
    label: `${url.hostname}/${database}`,
    local: LOOPBACK_HOSTS.has(url.hostname) && env.NODE_ENV !== 'production',
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonical(source[key])]),
    );
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Independent of key order, and different for any change of script, target or plan. */
export function planCode(
  script: string,
  databaseLabel: string,
  items: readonly unknown[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ script, databaseLabel, items })))
    .digest('hex')
    .slice(0, 16);
}

/** Run one script's plan and, only if every condition holds, apply it. */
export async function runMaintenance(
  run: MaintenanceRun,
): Promise<MaintenanceOutcome> {
  const log = run.log ?? ((line: string) => console.log(line));
  const flags = parseMaintenanceFlags(run.argv);
  const target = describeDatabase(run.env);

  const plan = await run.buildPlan();
  const code = planCode(run.script, target.label, plan.items);

  log(
    `[${run.script}] database: ${target.label}${target.local ? ' (local)' : ''}`,
  );
  for (const line of plan.summary) log(`[${run.script}] ${line}`);
  for (const item of plan.items.slice(0, SHOWN_ITEMS)) {
    log(`[${run.script}]   ${JSON.stringify(canonical(item))}`);
  }
  if (plan.items.length > SHOWN_ITEMS) {
    log(`[${run.script}]   … and ${plan.items.length - SHOWN_ITEMS} more`);
  }
  if (plan.items.length === 0) {
    log(`[${run.script}] Nothing to change.`);
    return 'nothing_to_do';
  }

  if (!flags.apply) {
    log(`[${run.script}] DRY RUN: nothing was written.`);
    log(
      `[${run.script}] To apply exactly this plan: --apply --confirm=${code}` +
        (target.local ? '' : ` --allow-database=${target.label}`),
    );
    return 'dry_run';
  }
  if (!flags.confirm) {
    throw new MaintenanceRefusal(
      '--apply needs --confirm=<code> from a dry run. Nothing was written.',
    );
  }
  if (flags.confirm !== code) {
    throw new MaintenanceRefusal(
      'The confirmation code does not match this plan, which may have changed since the dry run. Nothing was written.',
    );
  }
  if (!target.local && flags.allowDatabase !== target.label) {
    throw new MaintenanceRefusal(
      `${target.label} is not a local database. Name it with --allow-database=${target.label} to write to it. Nothing was written.`,
    );
  }

  await run.apply();
  log(`[${run.script}] Applied.`);
  return 'applied';
}
