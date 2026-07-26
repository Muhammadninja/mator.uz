import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { resolveAlertingConfig, type AlertingConfig } from './alerting.config';
import {
  AlertSeverity,
  formatDuration,
  severityName,
  type AlertPayload,
} from './alerting.types';

/**
 * Suppression: maintenance mode, runtime silences, and the startup grace period.
 *
 * ── Why this exists ──
 * A deploy restarts the process. For the next minute or two the queues have not
 * drained, pools are still warming and the rate-window rules have no baseline —
 * so every rule's premise is temporarily false. Alerting through that produces
 * a guaranteed burst of false positives on EVERY release, which is how an alert
 * channel gets muted and then ignored. The same applies to planned maintenance.
 *
 * ── What is never silenced ──
 * Anything at or above `graceMinSeverity` (CRITICAL by default) goes out
 * regardless. Silencing an outage because a deploy happens to be running is how
 * a bad release reaches production unnoticed — the window in which alerts are
 * least trustworthy is also the window in which a real failure is most likely.
 *
 * ── Three independent suppressions ──
 *   1. STARTUP GRACE  — time-based, automatic, per-process (in-memory).
 *   2. MAINTENANCE    — env flag (MAINTENANCE=true), fixed for the process life.
 *   3. SILENCE        — runtime, Redis-backed, TTL'd, shared across instances
 *                       and revocable. This is what `/alerts silence 30m` sets.
 *
 * Silences live in Redis with a TTL rather than in memory precisely so they
 * cannot outlive their window: a forgotten silence expires on its own, and a
 * process restart neither loses one that should still apply nor resurrects one
 * that has expired.
 */

/** Why an alert was suppressed. `null` means it was not. */
export type SuppressionReason =
  | { kind: 'startup_grace'; remainingMs: number }
  | { kind: 'maintenance' }
  | { kind: 'silence'; scope: string; expiresAt: number };

/** A stored silence window. */
export interface SilenceRecord {
  /** Epoch ms when the silence ends. */
  expiresAt: number;
  /** Who/what requested it, for the audit log. */
  requestedBy: string;
  /** Optional free-text note ("deploying v2.3"). */
  reason: string;
}

@Injectable()
export class AlertSilenceService {
  private readonly logger = new Logger(AlertSilenceService.name);
  private readonly config: AlertingConfig;
  /**
   * When this process finished booting. In-memory by design: the grace period
   * is a property of THIS process's warm-up, so a restart must reset it and one
   * instance's boot must not silence another's alerts.
   */
  private readonly startedAt = Date.now();

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.config = resolveAlertingConfig(config);

    if (this.config.maintenanceMode) {
      this.logger.warn(
        'MAINTENANCE mode is ON — non-critical alerts are suppressed',
      );
    }
  }

  /**
   * Whether `payload` should be suppressed, and why.
   *
   * Returns `null` when the alert must be delivered. Checked by the evaluator
   * BEFORE any state transition is recorded, so a silenced condition does not
   * consume its own ACTIVATED transition — when the silence lifts, a still-true
   * condition alerts normally instead of having been marked "already notified".
   */
  async suppressionFor(
    payload: AlertPayload,
    now = Date.now(),
  ): Promise<SuppressionReason | null> {
    // Severity override first: a CRITICAL alert is never suppressed by any
    // mechanism, so we do not even pay a Redis round trip for it.
    if (payload.severity >= this.config.graceMinSeverity) return null;

    const graceEndsAt = this.startedAt + this.config.startupGraceSec * 1000;
    if (this.config.startupGraceSec > 0 && now < graceEndsAt) {
      return { kind: 'startup_grace', remainingMs: graceEndsAt - now };
    }

    if (this.config.maintenanceMode) return { kind: 'maintenance' };

    const silence = await this.activeSilence(payload, now);
    if (silence !== null) return silence;

    return null;
  }

  /**
   * Start (or extend) a silence.
   *
   * @param scope   `*` for everything, or a rule name to silence one rule.
   * @param minutes duration; clamped to [1, ALERT_MAX_SILENCE_MIN] so a typo
   *                cannot silence alerting indefinitely.
   */
  async silence(
    scope: string,
    minutes: number = this.config.defaultSilenceMin,
    requestedBy = 'operator',
    reason = '',
  ): Promise<SilenceRecord> {
    const clamped = Math.min(
      Math.max(Math.round(minutes), 1),
      this.config.maxSilenceMin,
    );
    const record: SilenceRecord = {
      expiresAt: Date.now() + clamped * 60 * 1000,
      requestedBy,
      reason,
    };

    await this.redis.setEx(silenceKey(scope), clamped * 60, record);

    this.logger.warn(
      `Alerts silenced for scope "${scope}" for ${clamped}m by ${requestedBy}` +
        (reason ? ` — ${reason}` : ''),
    );
    return record;
  }

  /** Lift a silence early. Returns true when one was actually removed. */
  async unsilence(scope: string): Promise<boolean> {
    const removed = await this.redis.del(silenceKey(scope));
    if (removed > 0) {
      this.logger.log(`Silence lifted for scope "${scope}"`);
    }
    return removed > 0;
  }

  /** Every silence currently in force, keyed by scope. */
  async activeSilences(): Promise<Map<string, SilenceRecord>> {
    const keys = await this.redis.scan(silenceKey('*'));
    const entries = await Promise.all(
      keys.map(async (key) => {
        const record = await this.redis.get<SilenceRecord>(key);
        return record && typeof record === 'object'
          ? ([stripSilencePrefix(key), record] as const)
          : null;
      }),
    );

    return new Map(
      entries.filter(
        (entry): entry is [string, SilenceRecord] => entry !== null,
      ),
    );
  }

  /** Human-readable description of why an alert was held back. */
  describe(reason: SuppressionReason): string {
    switch (reason.kind) {
      case 'startup_grace':
        return `startup grace period (${formatDuration(reason.remainingMs)} remaining)`;
      case 'maintenance':
        return 'maintenance mode';
      case 'silence':
        return `silence on "${reason.scope}"`;
    }
  }

  /**
   * The minimum severity that bypasses suppression — exposed so a log line can
   * explain WHY a given alert was or was not held back.
   */
  get bypassSeverity(): string {
    return severityName(this.config.graceMinSeverity);
  }

  /** Whether the process is still inside its startup grace window. */
  inStartupGrace(now = Date.now()): boolean {
    return (
      this.config.startupGraceSec > 0 &&
      now < this.startedAt + this.config.startupGraceSec * 1000
    );
  }

  /**
   * Find a silence covering this payload: either the global scope or one
   * matching its rule name. Rule-scoped silences let a known-noisy rule be
   * muted without going blind to everything else.
   */
  private async activeSilence(
    payload: AlertPayload,
    now: number,
  ): Promise<SuppressionReason | null> {
    for (const scope of [GLOBAL_SILENCE_SCOPE, payload.rule]) {
      const record = await this.redis.get<SilenceRecord>(silenceKey(scope));
      // A malformed row is ignored rather than trusted: a corrupt value must
      // never be able to silence alerting.
      if (!record || typeof record !== 'object') continue;
      if (record.expiresAt > now) {
        return { kind: 'silence', scope, expiresAt: record.expiresAt };
      }
    }
    return null;
  }
}

/** The scope that silences every rule. */
export const GLOBAL_SILENCE_SCOPE = '*';

const SILENCE_PREFIX = 'alert:silence:';

/** Redis key holding one silence window. */
export function silenceKey(scope: string): string {
  return `${SILENCE_PREFIX}${scope}`;
}

/** Inverse of {@link silenceKey}. */
export function stripSilencePrefix(key: string): string {
  return key.startsWith(SILENCE_PREFIX)
    ? key.slice(SILENCE_PREFIX.length)
    : key;
}

/**
 * Parse a duration like `30m`, `2h`, `90` (bare = minutes) into minutes.
 * Returns `null` for anything unparseable, so a caller can reject rather than
 * silently silencing for a default it did not intend.
 */
export function parseSilenceDuration(raw: string): number | null {
  const match = /^(\d+)\s*(m|min|h|hour|hours|minutes?)?$/i.exec(raw.trim());
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return null;

  const unit = (match[2] ?? 'm').toLowerCase();
  return unit.startsWith('h') ? amount * 60 : amount;
}

/** Re-exported for callers that build a payload-shaped probe for a check. */
export type { AlertSeverity };
