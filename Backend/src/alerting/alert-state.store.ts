import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { resolveAlertingConfig } from './alerting.config';
import { ALERT_STATE, type AlertState } from './alerting.types';

/**
 * Persisted state of one alert instance.
 *
 * Only ACTIVE alerts have a row. Resolution DELETES the row rather than writing
 * `RESOLVED` — "no row" is the resting state, so the keyspace stays bounded by
 * the number of CURRENTLY firing alerts rather than by every alert ever seen.
 */
export interface StoredAlertState {
  state: AlertState;
  /** Epoch ms when this alert first became ACTIVE (survives re-confirmation). */
  activeSince: number;
  /** Epoch ms of the most recent notification sent for this instance. */
  lastNotifiedAt: number;
}

/** What the evaluator should do about an alert instance this evaluation. */
export const TRANSITION = {
  /** Was not firing, now is → send the ACTIVE message. */
  ACTIVATED: 'ACTIVATED',
  /** Still firing, already notified → send nothing. */
  SUPPRESSED: 'SUPPRESSED',
  /** Still firing but ACTIVE long enough to resurface → re-send. */
  RENOTIFY: 'RENOTIFY',
  /** Was firing, no longer is → send the RESOLVED message. */
  RESOLVED: 'RESOLVED',
} as const;

export type Transition = (typeof TRANSITION)[keyof typeof TRANSITION];

/**
 * The outcome of recording one firing observation: which transition it implies,
 * plus how long the alert has been ACTIVE.
 *
 * `activeForMs` is what lets a re-notification say "still active — 3h 25m"
 * instead of repeating the original message verbatim. It is measured from the
 * stored `activeSince`, so it survives the process restarts that a long
 * incident will outlive.
 */
export interface FiringOutcome {
  transition: Transition;
  /** Milliseconds since this alert first became ACTIVE. 0 on activation. */
  activeForMs: number;
}

/**
 * Redis-backed alert state — the deduplication mechanism.
 *
 * Why Redis rather than an in-process Map (which is what the older
 * ops/AlertService uses): alert state must be shared across every backend
 * instance and must survive a restart. With in-process state, three PM2 workers
 * observing the same backlog send three Telegram messages, and a deploy during
 * an incident re-sends everything that is still broken. Redis is already
 * required infrastructure here, so this costs one round trip per alert instance
 * per minute.
 *
 * The state machine, per dedupe key:
 *
 *   (no row) --firing--> ACTIVE  [notify ACTIVE]
 *   ACTIVE   --firing--> ACTIVE  [suppress, or re-notify after renotifyMin]
 *   ACTIVE   --clear---> (no row)[notify RESOLVED]
 *   (no row) --clear---> (no row)[nothing — never notify a non-incident]
 *
 * `markFiring` is a compare-and-set via SET NX: two instances evaluating the
 * same condition in the same second race on the same key, and exactly one wins
 * the ACTIVATED transition. That is what makes "send only once" hold across
 * instances rather than only within one process.
 */
@Injectable()
export class AlertStateStore {
  private readonly logger = new Logger(AlertStateStore.name);
  private readonly ttlSec: number;
  private readonly renotifyMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const resolved = resolveAlertingConfig(config);
    this.ttlSec = resolved.stateTtlSec;
    this.renotifyMs = resolved.renotifyMin * 60 * 1000;
  }

  /**
   * Record that `dedupeKey` is firing, and report which transition that implies.
   *
   * Returns ACTIVATED only for the caller that actually created the row — so
   * only one instance/process notifies, even under a race.
   */
  async markFiring(
    dedupeKey: string,
    now = Date.now(),
  ): Promise<FiringOutcome> {
    const key = alertStateKey(dedupeKey);
    const fresh: StoredAlertState = {
      state: ALERT_STATE.ACTIVE,
      activeSince: now,
      lastNotifiedAt: now,
    };

    // SET NX: creates the row only if absent. `won` is true for exactly one
    // caller across all instances — the one that gets to announce the alert.
    const won = await this.redis
      .getClient()
      .set(key, JSON.stringify(fresh), 'EX', this.ttlSec, 'NX');

    if (won === 'OK') {
      return { transition: TRANSITION.ACTIVATED, activeForMs: 0 };
    }

    // Row already exists → the alert is known. Decide suppress vs re-notify.
    const existing = await this.read(key);
    if (existing === null) {
      // The row expired between the SET NX and this read (a TTL boundary, or a
      // concurrent resolve). Treat as a fresh activation rather than silently
      // dropping the alert — a duplicate message is far cheaper than a missed one.
      await this.write(key, fresh);
      return { transition: TRANSITION.ACTIVATED, activeForMs: 0 };
    }

    const shouldRenotify =
      this.renotifyMs > 0 && now - existing.lastNotifiedAt >= this.renotifyMs;

    await this.write(key, {
      ...existing,
      state: ALERT_STATE.ACTIVE,
      // Only advance the notification clock when we actually re-notify;
      // otherwise the interval would never elapse.
      lastNotifiedAt: shouldRenotify ? now : existing.lastNotifiedAt,
    });

    return {
      transition: shouldRenotify ? TRANSITION.RENOTIFY : TRANSITION.SUPPRESSED,
      // Measured from first activation, NOT from the last notification, so the
      // message reports total incident age.
      activeForMs: Math.max(0, now - existing.activeSince),
    };
  }

  /**
   * Record that `dedupeKey` is no longer firing.
   *
   * Returns RESOLVED only when there WAS an active row — a condition that was
   * never firing must never produce a "✅ Resolved" message. The DEL result is
   * the compare-and-set: exactly one caller sees the 1.
   */
  async markCleared(
    dedupeKey: string,
    now = Date.now(),
  ): Promise<FiringOutcome | null> {
    const key = alertStateKey(dedupeKey);
    // Read BEFORE deleting so the resolution message can report how long the
    // incident lasted. A missing row here is not an error — it just means this
    // caller lost the race, and the DEL below is what decides who notifies.
    const existing = await this.read(key);

    const removed = await this.redis.del(key);
    if (removed === 0) return null;

    return {
      transition: TRANSITION.RESOLVED,
      activeForMs:
        existing === null ? 0 : Math.max(0, now - existing.activeSince),
    };
  }

  /** Every dedupe key currently ACTIVE. Used to detect what has recovered. */
  async activeKeys(): Promise<string[]> {
    const keys = await this.redis.scan(alertStateKey('*'));
    return keys.map(stripAlertStatePrefix);
  }

  /** Read one alert's state, or null when it isn't active. */
  async get(dedupeKey: string): Promise<StoredAlertState | null> {
    return this.read(alertStateKey(dedupeKey));
  }

  private async read(key: string): Promise<StoredAlertState | null> {
    const raw = await this.redis.get<StoredAlertState>(key);
    // RedisService.get returns the raw string when the value isn't JSON. A
    // corrupted row must not crash evaluation — treat it as absent so the alert
    // simply re-activates.
    if (raw === null || typeof raw !== 'object') {
      if (raw !== null) {
        this.logger.warn(`Discarding malformed alert state at "${key}"`);
      }
      return null;
    }
    return raw;
  }

  private async write(key: string, value: StoredAlertState): Promise<void> {
    await this.redis.setEx(key, this.ttlSec, value);
  }
}

/** Redis key prefix for alert state. Namespaced so SCAN can enumerate it. */
const ALERT_STATE_PREFIX = 'alert:state:';

/** The Redis key holding one alert instance's state. */
export function alertStateKey(dedupeKey: string): string {
  return `${ALERT_STATE_PREFIX}${dedupeKey}`;
}

/** Inverse of {@link alertStateKey}. */
export function stripAlertStatePrefix(key: string): string {
  return key.startsWith(ALERT_STATE_PREFIX)
    ? key.slice(ALERT_STATE_PREFIX.length)
    : key;
}
