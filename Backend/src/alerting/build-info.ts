import { hostname } from 'node:os';
import type { ConfigService } from '@nestjs/config';
import type { AlertSource } from './alerting.types';

/**
 * Resolves WHICH BUILD and WHICH INSTANCE this process is, once at boot.
 *
 * ── Why this is worth a file ──
 * The first two questions asked when an alert lands are "is this the new
 * release or the old one?" and "which instance?". Both are answerable from
 * data the process already has, and answering them inside the message removes a
 * lookup from the critical path of an incident — at 3am, "commit 81e6fd3" in
 * the alert beats SSH-ing in to check what is deployed.
 *
 * ── Resolution order ──
 * Version and commit come from the environment first (APP_VERSION /
 * GIT_COMMIT), because in a real deploy that is where CI knows the truth: the
 * container tag or the checked-out SHA. `package.json` is the fallback so a
 * plain `npm start` still reports something meaningful rather than "unknown".
 *
 * The commit is trimmed to a short SHA — the only form anyone types or reads.
 */

/** Short-SHA length, matching `git rev-parse --short` (7 chars). */
const SHORT_SHA_LENGTH = 7;

/** Reported when a value genuinely cannot be determined. */
export const UNKNOWN_VERSION = 'unknown';

/**
 * Read the version from package.json. Wrapped in try/catch because a bundled or
 * relocated build may not have it on disk, and a missing version file must
 * NEVER prevent the process from starting — the version is diagnostic metadata,
 * not a dependency.
 */
function versionFromPackageJson(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * The PM2 instance label.
 *
 * PM2 sets `NODE_APP_INSTANCE` (0-based worker index in cluster mode) and
 * `name`/`pm_id`. Rendered as `worker-3` when clustered. Returns '' when not
 * running under PM2, so the field is simply omitted from the message rather
 * than showing a meaningless placeholder.
 *
 * NOTE: the current ecosystem.config.js runs `fork` mode with instances: 1, so
 * this is normally `worker-0`. It exists for the multi-instance future the
 * config's own comment anticipates — at which point knowing WHICH worker raised
 * an alert is the difference between one bad process and a systemic failure.
 */
export function resolveInstanceLabel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const index = env.NODE_APP_INSTANCE ?? env.pm_id;
  if (index === undefined || index.trim() === '') return '';
  return `worker-${index.trim()}`;
}

/** Trim a full SHA to its short form; pass through anything already short. */
export function shortCommit(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return '';
  return /^[0-9a-f]{7,40}$/i.test(trimmed)
    ? trimmed.slice(0, SHORT_SHA_LENGTH).toLowerCase()
    : trimmed;
}

/**
 * Build the {@link AlertSource} for this process.
 *
 * Called once (the module binds it to a DI value provider), because none of it
 * can change while the process is alive — re-reading `os.hostname()` per alert
 * would be pure waste.
 */
export function resolveAlertSource(
  config: Pick<ConfigService, 'get'>,
  env: NodeJS.ProcessEnv = process.env,
): AlertSource {
  const version =
    config.get<string>('APP_VERSION')?.trim() || versionFromPackageJson();

  const commit = shortCommit(
    config.get<string>('GIT_COMMIT') ??
      config.get<string>('COMMIT_SHA') ??
      // Set automatically by several CI/PaaS providers, so a deploy from one of
      // them reports its commit with no extra configuration.
      env.SOURCE_VERSION ??
      env.RENDER_GIT_COMMIT ??
      env.VERCEL_GIT_COMMIT_SHA,
  );

  return {
    version: version === '' ? UNKNOWN_VERSION : version,
    commit,
    // ALERT_HOST_LABEL lets a deploy report a meaningful name ("backend-02")
    // where the raw hostname is a container id nobody recognises.
    host: config.get<string>('ALERT_HOST_LABEL')?.trim() || hostname(),
    instance: resolveInstanceLabel(env),
    pid: process.pid,
  };
}

/** DI token for the process-wide {@link AlertSource}. */
export const ALERT_SOURCE = Symbol('ALERT_SOURCE');
