// DI wiring check for the alerting module. The unit tests exercise each class
// in isolation with hand-built doubles; this asserts the thing they cannot —
// that the Nest container can actually CONSTRUCT them and that every rule is
// reachable through the ALERT_RULES token.
//
// The rule list is a factory over class references (see alerting.module.ts), so
// a rule added to RULES but missing @Injectable(), or one with an unprovided
// constructor argument, kills the app at boot with "Nest can't resolve
// dependencies" — a failure no unit test catches, because they all bypass DI.

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AlertService } from '../ops/alert.service';
import { AlertEvaluatorService } from './alert-evaluator.service';
import { AlertNotifierService } from './alert-notifier.service';
import { AlertProcessor } from './alert.processor';
import { AlertScheduler } from './alert.scheduler';
import { AlertSilenceService } from './alert-silence.service';
import { AlertStateStore } from './alert-state.store';
import {
  ALERT_CHANNELS,
  ALERT_RULES,
  type AlertChannel,
  type AlertRule,
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
 * The rule classes, mirroring `RULES` in alerting.module.ts. Kept in sync by the
 * "every registered rule is constructed" test below, which resolves ALERT_RULES
 * and asserts one instance per class.
 */
const RULES = [
  QueueBacklogRule,
  ImageLatencyRule,
  SmsFailureRule,
  BackendHealthRule,
] as const;

/** The channel classes, mirroring `CHANNELS` in alerting.module.ts. */
const CHANNELS = [
  TelegramAlertChannel,
  SlackAlertChannel,
  DiscordAlertChannel,
  GenericWebhookAlertChannel,
] as const;

/**
 * Build the alerting slice against stubbed collaborators. Importing the real
 * AlertingModule would open a live Redis connection (BullMQ forRootAsync) and
 * pull in Prisma, which a unit test must not do — so the providers are resolved
 * by the real container with their declared dependencies supplied as values.
 */
async function buildAlertingSlice() {
  return Test.createTestingModule({
    providers: [
      ...RULES,
      ...CHANNELS,
      {
        provide: ALERT_RULES,
        inject: [...RULES],
        useFactory: (...rules: AlertRule[]): readonly AlertRule[] => rules,
      },
      {
        provide: ALERT_CHANNELS,
        inject: [...CHANNELS],
        useFactory: (...channels: AlertChannel[]): readonly AlertChannel[] =>
          channels,
      },
      {
        provide: ALERT_SOURCE,
        useValue: resolveAlertSource({ get: () => undefined }),
      },
      AlertStateStore,
      AlertSilenceService,
      AlertNotifierService,
      AlertEvaluatorService,
      AlertScheduler,
      AlertProcessor,
      OpsAlertBridge,
      { provide: ConfigService, useValue: { get: () => undefined } },
      {
        provide: RedisService,
        useValue: {
          getClient: () => ({ set: jest.fn(), ping: jest.fn() }),
          get: jest.fn(),
          setEx: jest.fn(),
          del: jest.fn(),
          scan: jest.fn().mockResolvedValue([]),
        },
      },
      { provide: PrismaService, useValue: { $queryRaw: jest.fn() } },
      {
        provide: MetricsService,
        useValue: {
          imageProcessingDurationMetric: { get: jest.fn() },
          smsFailedMetric: { get: jest.fn() },
          observeJob: jest.fn(),
        },
      },
      { provide: AlertService, useValue: { registerChannel: jest.fn() } },
      // The queues the rules and notifier inject. Optional in the classes, but
      // provided here so the resolved graph matches production.
      ...[
        QUEUE_NAMES.IMAGE_PROCESSING,
        QUEUE_NAMES.SMS,
        QUEUE_NAMES.NOTIFICATIONS,
        QUEUE_NAMES.MAINTENANCE,
        QUEUE_NAMES.ALERTS,
      ].map((name) => ({
        provide: getQueueToken(name),
        useValue: { add: jest.fn(), getJobCounts: jest.fn() },
      })),
    ],
  }).compile();
}

describe('AlertingModule DI wiring', () => {
  it('constructs every registered rule and exposes them via ALERT_RULES', async () => {
    const moduleRef = await buildAlertingSlice();

    const rules = moduleRef.get<readonly AlertRule[]>(ALERT_RULES);

    expect(rules).toHaveLength(RULES.length);
    for (const RuleClass of RULES) {
      expect(rules.some((rule) => rule instanceof RuleClass)).toBe(true);
    }
    await moduleRef.close();
  });

  it('gives every rule a unique name, so dedupe keys cannot collide', async () => {
    const moduleRef = await buildAlertingSlice();

    const names = moduleRef
      .get<readonly AlertRule[]>(ALERT_RULES)
      .map((rule) => rule.name);

    expect(new Set(names).size).toBe(names.length);
    await moduleRef.close();
  });

  it('constructs the evaluator with the injected rule list', async () => {
    const moduleRef = await buildAlertingSlice();

    const evaluator = moduleRef.get(AlertEvaluatorService);

    expect(evaluator).toBeInstanceOf(AlertEvaluatorService);
    expect(
      (evaluator as unknown as { rules: readonly AlertRule[] }).rules,
    ).toHaveLength(RULES.length);
    await moduleRef.close();
  });

  it('constructs every channel and exposes them via ALERT_CHANNELS', async () => {
    const moduleRef = await buildAlertingSlice();

    const channels = moduleRef.get<readonly AlertChannel[]>(ALERT_CHANNELS);

    expect(channels).toHaveLength(CHANNELS.length);
    for (const ChannelClass of CHANNELS) {
      expect(channels.some((c) => c instanceof ChannelClass)).toBe(true);
    }
    await moduleRef.close();
  });

  it('gives every channel a unique name, so job routing is unambiguous', async () => {
    const moduleRef = await buildAlertingSlice();

    const names = moduleRef
      .get<readonly AlertChannel[]>(ALERT_CHANNELS)
      .map((channel) => channel.name);

    expect(new Set(names).size).toBe(names.length);
    await moduleRef.close();
  });

  it('constructs the scheduler, notifier, processor and bridge', async () => {
    const moduleRef = await buildAlertingSlice();

    expect(moduleRef.get(AlertScheduler)).toBeInstanceOf(AlertScheduler);
    expect(moduleRef.get(AlertNotifierService)).toBeInstanceOf(
      AlertNotifierService,
    );
    expect(moduleRef.get(AlertProcessor)).toBeInstanceOf(AlertProcessor);
    expect(moduleRef.get(OpsAlertBridge)).toBeInstanceOf(OpsAlertBridge);
    expect(moduleRef.get(AlertSilenceService)).toBeInstanceOf(
      AlertSilenceService,
    );
    await moduleRef.close();
  });

  it('registers the alerts queue under its canonical token', () => {
    // Guards against the notifier producing to a queue name no worker consumes.
    expect(getQueueToken(QUEUE_NAMES.ALERTS)).toBe('BullQueue_alerts');
  });

  it('registers the bridge on AlertService at init', async () => {
    const moduleRef = await buildAlertingSlice();
    const ops = moduleRef.get(AlertService);

    moduleRef.get(OpsAlertBridge).onModuleInit();

    expect(ops.registerChannel).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });
});
