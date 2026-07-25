import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  alertKey,
  type Alert,
  type AlertChannel,
  type AlertSeverity,
} from './alert.types';
import { resolveQueueMonitorConfig } from './ops.config';

/** Bookkeeping for one alert key's suppression window. */
interface AlertState {
  /** When the most recent alert for this key was actually emitted. */
  lastFiredAt: number;
  /** How many occurrences were suppressed since then. */
  suppressed: number;
}

/**
 * Central alert dispatcher.
 *
 * Two responsibilities, both transport-agnostic:
 *   1. DEDUPE — a condition that stays true (a queue with a growing backlog is
 *      re-observed every sample) must not produce one alert per sample. Each
 *      `type:queue` key is suppressed for QUEUE_ALERT_COOLDOWN_MIN after firing;
 *      when the cooldown expires the alert re-fires, reporting how many
 *      occurrences were swallowed so the noise is accounted for rather than lost.
 *   2. FAN-OUT — deliver to every registered channel. Today the only channel is
 *      the logger (below); `registerChannel` is the seam where Telegram, email or
 *      a Prometheus gauge is added later WITHOUT touching detection logic.
 *
 * State is in-process and intentionally so: this is Phase 1 tooling, and a
 * per-instance cooldown is the correct scope for a per-instance log line. Moving
 * dedupe to Redis is the natural next step when alerts reach a real channel and
 * multi-instance duplicate suppression starts to matter (see RECOMMENDATIONS).
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private readonly channels: AlertChannel[] = [];
  private readonly state = new Map<string, AlertState>();
  private readonly cooldownMs: number;

  constructor(config: ConfigService) {
    this.cooldownMs = resolveQueueMonitorConfig(config).cooldownMin * 60 * 1000;
    // The default channel: structured logs. Registered here (not in the module)
    // so an AlertService is always useful on its own, including in tests.
    this.registerChannel(new LoggingAlertChannel());
  }

  /**
   * Add a delivery destination. Call from a module's `onModuleInit` (or any
   * bootstrap path) to wire a new transport in.
   */
  registerChannel(channel: AlertChannel): void {
    this.channels.push(channel);
  }

  /**
   * Raise an alert. Returns `true` when it was dispatched, `false` when the
   * cooldown suppressed it — the return value exists so callers/tests can assert
   * on dedupe without reading private state.
   */
  async raise(alert: Alert): Promise<boolean> {
    const key = alertKey(alert);
    const now = alert.firedAt.getTime();
    const previous = this.state.get(key);

    if (previous && now - previous.lastFiredAt < this.cooldownMs) {
      previous.suppressed += 1;
      return false;
    }

    // Surface how much noise the previous window absorbed, so a long-running
    // condition reads as "still broken, 14 more occurrences" rather than a bare
    // repeat that looks like a fresh incident.
    const enriched: Alert =
      previous && previous.suppressed > 0
        ? {
            ...alert,
            context: {
              ...alert.context,
              suppressedSinceLastAlert: previous.suppressed,
            },
          }
        : alert;

    this.state.set(key, { lastFiredAt: now, suppressed: 0 });
    await this.dispatch(enriched);
    return true;
  }

  /**
   * Clear the suppression window for a key whose condition has recovered, so the
   * NEXT occurrence alerts immediately instead of being swallowed by a cooldown
   * started before the recovery.
   */
  resolve(alert: Pick<Alert, 'type' | 'queue'>): void {
    this.state.delete(alertKey(alert));
  }

  /**
   * Deliver to every channel. One failing channel must never prevent the others
   * from receiving the alert, nor propagate into the monitor's sampling loop.
   */
  private async dispatch(alert: Alert): Promise<void> {
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.deliver(alert);
        } catch (err) {
          this.logger.error(
            `Alert channel "${channel.name}" failed to deliver ${alert.type} for ${alert.queue}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );
  }
}

/**
 * The built-in channel: writes the alert to the Nest logger with its full
 * context as JSON, so PM2/journald capture is enough to debug an incident with
 * no external system attached.
 */
export class LoggingAlertChannel implements AlertChannel {
  readonly name = 'logger';
  private readonly logger = new Logger('QueueAlert');

  deliver(alert: Alert): void {
    const line = `[${alert.type}] queue=${alert.queue} ${alert.message} ${JSON.stringify(alert.context)}`;
    this.log(alert.severity, line);
  }

  private log(severity: AlertSeverity, line: string): void {
    if (severity === 'critical') {
      this.logger.error(line);
      return;
    }
    this.logger.warn(line);
  }
}
