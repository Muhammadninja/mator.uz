import { Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { OpsModule } from '../ops/ops.module';
import { AlertEvaluatorService } from './alert-evaluator.service';
import { AlertNotifierService } from './alert-notifier.service';
import { AlertProcessor } from './alert.processor';
import { AlertTestController } from './alert-test.controller';
import { AlertScheduler } from './alert.scheduler';
import { AlertSilenceService } from './alert-silence.service';
import { AlertStateStore } from './alert-state.store';
import {
  ALERT_CHANNELS,
  ALERT_RULES,
  type AlertChannel,
  type AlertRule,
  type AlertSource,
} from './alerting.types';
import { ALERT_SOURCE, resolveAlertSource } from './build-info';
import { DiscordAlertChannel } from './channels/discord.channel';
import { GenericWebhookAlertChannel } from './channels/generic-webhook.channel';
import { SlackAlertChannel } from './channels/slack.channel';
import { TelegramAlertChannel } from './channels/telegram.channel';
import { OpsAlertBridge } from './ops-alert.bridge';
import { BackendHealthRule } from './rules/backend-health.rule';
import { ImageLatencyRule } from './rules/image-latency.rule';
import { QueueBacklogRule } from './rules/queue-backlog.rule';
import { SmsFailureRule } from './rules/sms-failure.rule';

/**
 * Internal alerting: evaluate rules every minute, deduplicate against Redis
 * state, and deliver ACTIVE/RESOLVED notifications across every configured
 * channel via BullMQ.
 *
 * Deliberately NOT Alertmanager. Everything it would provide — scheduling,
 * dedupe, state, silences, retrying delivery, notification transports —
 * already exists in this backend (Nest schedulers, Redis, BullMQ, a Telegram
 * bot), so a separate service would add an operational dependency, a second
 * config language, and a second place to look during an incident. It would
 * also alert only on what Prometheus can see; a rule here can run a live
 * `SELECT 1`.
 *
 * Strictly additive: no rule mutates anything. The queue rule only calls
 * `getJobCounts`, the metric rules only READ existing prom-client series, and
 * the health rule issues `SELECT 1` / `PING`. No business flow, payload, retry
 * policy or schema is touched by this module running — or by it being disabled.
 *
 * ── Adding a rule ──
 * Implement `AlertRule`, then add the class to `RULES` below. Nothing else
 * changes: dedupe, resolution, suppression, notification, retry and logging are
 * inherited from the evaluator.
 *
 * ── Adding a channel ──
 * Implement `AlertChannel`, then add the class to `CHANNELS` below. The
 * notifier fans out to every channel that is `configured` and `accepts()` the
 * alert, so a new destination needs no change to any rule or to the evaluator.
 */

/**
 * Every registered rule. The ONE list a new rule is added to — kept adjacent to
 * the providers so the two can never drift apart.
 */
const RULES = [
  QueueBacklogRule,
  ImageLatencyRule,
  SmsFailureRule,
  BackendHealthRule,
] as const;

/**
 * Every delivery channel, in declaration order.
 *
 * All four are always PROVIDED but only the configured ones ever receive an
 * alert (`AlertChannel.configured` gates enqueueing). So an operator turns
 * Slack on by setting ALERT_SLACK_WEBHOOK_URL — no deploy, no code change.
 */
const CHANNELS = [
  TelegramAlertChannel,
  SlackAlertChannel,
  DiscordAlertChannel,
  GenericWebhookAlertChannel,
] as const;

/**
 * Bind the rule classes to the injected ALERT_RULES array. Using a factory over
 * the class list (rather than a hand-written array of instances) is what makes
 * "add the class to RULES" genuinely sufficient — the DI container constructs
 * each one with its own dependencies.
 */
const rulesProvider: Provider = {
  provide: ALERT_RULES,
  inject: [...RULES],
  useFactory: (...rules: AlertRule[]): readonly AlertRule[] => rules,
};

/** Same pattern for the channels. */
const channelsProvider: Provider = {
  provide: ALERT_CHANNELS,
  inject: [...CHANNELS],
  useFactory: (...channels: AlertChannel[]): readonly AlertChannel[] =>
    channels,
};

/**
 * Which build and which instance this process is — resolved ONCE at boot.
 *
 * A value provider rather than a per-alert lookup because none of it can change
 * while the process lives: re-reading `os.hostname()` or `package.json` on every
 * alert would be pure waste.
 */
const sourceProvider: Provider = {
  provide: ALERT_SOURCE,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AlertSource =>
    resolveAlertSource(config),
};

@Module({
  imports: [
    ConfigModule,
    // Re-registering the queues obtains the SAME instances via DI —
    // @nestjs/bullmq resolves registrations by name against the connection
    // configured in QueueModule.forRootAsync. It does NOT create a second set.
    // ALERTS is registered here (rather than in QueueModule) because this is the
    // only module that produces or consumes it, and AlertProcessor below is its
    // one worker.
    BullModule.registerQueue(
      { name: QUEUE_NAMES.IMAGE_PROCESSING },
      { name: QUEUE_NAMES.SMS },
      { name: QUEUE_NAMES.NOTIFICATIONS },
      { name: QUEUE_NAMES.MAINTENANCE },
      { name: QUEUE_NAMES.ALERTS },
    ),
    // AlertService, so OpsAlertBridge can register itself as a delivery channel
    // for the existing queue-monitor alerts.
    OpsModule,
  ],
  // The ADMIN-guarded smoke-test endpoint (POST api/admin/alerts/test), which
  // pushes a synthetic notification through the real delivery path.
  controllers: [AlertTestController],
  providers: [
    ...RULES,
    ...CHANNELS,
    rulesProvider,
    channelsProvider,
    sourceProvider,
    AlertStateStore,
    AlertSilenceService,
    AlertNotifierService,
    AlertEvaluatorService,
    AlertScheduler,
    AlertProcessor,
    OpsAlertBridge,
  ],
  // Exported so a future admin endpoint can trigger an evaluation or manage
  // silences, and so any module can raise a notification through the same path
  // rather than inventing a second one.
  exports: [AlertEvaluatorService, AlertNotifierService, AlertSilenceService],
})
export class AlertingModule {}
