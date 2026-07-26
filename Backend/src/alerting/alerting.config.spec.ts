import { ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from '../queue/queue.constants';
import {
  BACKLOG_MONITORED_QUEUES,
  nonNegativeIntEnv,
  positiveFloatEnv,
  queueThresholdEnvVar,
  resolveAlertingConfig,
  resolveQueueThresholds,
  resolveRuleLinkTemplates,
} from './alerting.config';
import { AlertSeverity, renderUrlTemplate } from './alerting.types';

/**
 * Requirement 6: every threshold comes from configuration, never hardcoded.
 * These tests assert that each documented env var actually reaches the resolved
 * config, and that a bad value degrades to a safe default instead of producing
 * a NaN threshold that silently never fires.
 */

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

describe('resolveAlertingConfig', () => {
  it('runs with safe defaults when nothing is configured', () => {
    const config = resolveAlertingConfig(configWith());

    expect(config.enabled).toBe(true);
    expect(config.intervalSec).toBe(60);
    expect(config.imageP95ThresholdSec).toBe(45);
    expect(config.smsFailureThreshold).toBe(10);
    expect(config.rateWindowMin).toBe(5);
    // Delivery is off until a chat id is supplied — an unconfigured deployment
    // logs alerts rather than failing every send.
    expect(config.telegramChatId).toBe('');
    // Re-notification is ON by default: an alert that fires once and goes
    // quiet is indistinguishable from one that resolved.
    expect(config.renotifyMin).toBe(30);
    // And a deploy gets a two-minute grace window.
    expect(config.startupGraceSec).toBe(120);
    expect(config.maintenanceMode).toBe(false);
    expect(config.graceMinSeverity).toBe(AlertSeverity.CRITICAL);
  });

  it('reads every documented threshold from the environment', () => {
    const config = resolveAlertingConfig(
      configWith({
        IMAGE_PROCESSING_P95_THRESHOLD: '30.5',
        SMS_FAILURE_THRESHOLD: '25',
        ALERT_RATE_WINDOW_MIN: '10',
        ALERTING_INTERVAL_SEC: '120',
      }),
    );

    expect(config.imageP95ThresholdSec).toBe(30.5);
    expect(config.smsFailureThreshold).toBe(25);
    expect(config.rateWindowMin).toBe(10);
    expect(config.intervalSec).toBe(120);
  });

  it('can be disabled explicitly', () => {
    expect(
      resolveAlertingConfig(configWith({ ALERTING_ENABLED: 'false' })).enabled,
    ).toBe(false);
  });

  it('falls back to TELEGRAM_BOT_TOKEN so the existing bot is reused', () => {
    expect(
      resolveAlertingConfig(configWith({ TELEGRAM_BOT_TOKEN: 'seller-token' }))
        .telegramBotToken,
    ).toBe('seller-token');
  });

  it('prefers a dedicated ops bot token when one is set', () => {
    expect(
      resolveAlertingConfig(
        configWith({
          TELEGRAM_BOT_TOKEN: 'seller-token',
          ALERT_TELEGRAM_BOT_TOKEN: 'ops-token',
        }),
      ).telegramBotToken,
    ).toBe('ops-token');
  });

  it('ignores invalid values rather than producing a NaN threshold', () => {
    // A NaN threshold compares false against everything, so the alert would
    // never fire — a silent monitoring gap. Falling back is the safe read.
    const config = resolveAlertingConfig(
      configWith({
        SMS_FAILURE_THRESHOLD: 'many',
        IMAGE_PROCESSING_P95_THRESHOLD: '-5',
      }),
    );

    expect(config.smsFailureThreshold).toBe(10);
    expect(config.imageP95ThresholdSec).toBe(45);
  });
});

describe('resolveQueueThresholds', () => {
  it('covers every backlog-monitored queue', () => {
    const thresholds = resolveQueueThresholds(configWith());

    for (const queue of BACKLOG_MONITORED_QUEUES) {
      expect(thresholds[queue]).toBeGreaterThan(0);
    }
  });

  it('excludes the alerts queue — a watchdog must not watch itself', () => {
    expect(BACKLOG_MONITORED_QUEUES).not.toContain(QUEUE_NAMES.ALERTS);
  });

  it('honours the documented short alias', () => {
    const thresholds = resolveQueueThresholds(
      configWith({ IMAGE_QUEUE_ALERT_THRESHOLD: '42' }),
    );

    expect(thresholds[QUEUE_NAMES.IMAGE_PROCESSING]).toBe(42);
  });

  it('honours the systematic derived name', () => {
    const thresholds = resolveQueueThresholds(
      configWith({ IMAGE_PROCESSING_QUEUE_ALERT_THRESHOLD: '77' }),
    );

    expect(thresholds[QUEUE_NAMES.IMAGE_PROCESSING]).toBe(77);
  });

  it('prefers the alias over the derived name when both are set', () => {
    const thresholds = resolveQueueThresholds(
      configWith({
        IMAGE_QUEUE_ALERT_THRESHOLD: '42',
        IMAGE_PROCESSING_QUEUE_ALERT_THRESHOLD: '77',
      }),
    );

    expect(thresholds[QUEUE_NAMES.IMAGE_PROCESSING]).toBe(42);
  });

  it('applies the generic fallback to every queue', () => {
    const thresholds = resolveQueueThresholds(
      configWith({ QUEUE_ALERT_THRESHOLD: '15' }),
    );

    for (const queue of BACKLOG_MONITORED_QUEUES) {
      expect(thresholds[queue]).toBe(15);
    }
  });

  it('lets a per-queue value override the generic fallback', () => {
    const thresholds = resolveQueueThresholds(
      configWith({
        QUEUE_ALERT_THRESHOLD: '15',
        SMS_QUEUE_ALERT_THRESHOLD: '400',
      }),
    );

    expect(thresholds[QUEUE_NAMES.SMS]).toBe(400);
    expect(thresholds[QUEUE_NAMES.IMAGE_PROCESSING]).toBe(15);
  });
});

describe('queueThresholdEnvVar', () => {
  it('derives the env var name from the queue name', () => {
    expect(queueThresholdEnvVar('image-processing')).toBe(
      'IMAGE_PROCESSING_QUEUE_ALERT_THRESHOLD',
    );
    expect(queueThresholdEnvVar('sms')).toBe('SMS_QUEUE_ALERT_THRESHOLD');
  });
});

describe('severity configuration', () => {
  it('parses a named severity from env', () => {
    expect(
      resolveAlertingConfig(configWith({ ALERT_MIN_SEVERITY: 'ERROR' }))
        .minSeverity,
    ).toBe(AlertSeverity.ERROR);
  });

  it('is case-insensitive and falls back on garbage', () => {
    expect(
      resolveAlertingConfig(configWith({ ALERT_MIN_SEVERITY: 'critical' }))
        .minSeverity,
    ).toBe(AlertSeverity.CRITICAL);
    expect(
      resolveAlertingConfig(configWith({ ALERT_MIN_SEVERITY: 'loud' }))
        .minSeverity,
    ).toBe(AlertSeverity.WARNING);
  });

  it('lets ALERT_MIN_SEVERITY raise the floor for every channel at once', () => {
    const config = resolveAlertingConfig(
      configWith({ ALERT_MIN_SEVERITY: 'ERROR' }),
    );

    expect(config.telegramMinSeverity).toBe(AlertSeverity.ERROR);
    expect(config.slackMinSeverity).toBe(AlertSeverity.ERROR);
    expect(config.discordMinSeverity).toBe(AlertSeverity.ERROR);
  });

  it('lets a per-channel value override the shared floor', () => {
    const config = resolveAlertingConfig(
      configWith({
        ALERT_MIN_SEVERITY: 'WARNING',
        ALERT_SLACK_MIN_SEVERITY: 'CRITICAL',
      }),
    );

    expect(config.slackMinSeverity).toBe(AlertSeverity.CRITICAL);
    expect(config.telegramMinSeverity).toBe(AlertSeverity.WARNING);
  });
});

describe('suppression configuration', () => {
  it('reads the startup grace period', () => {
    expect(
      resolveAlertingConfig(configWith({ ALERT_STARTUP_GRACE_SEC: '300' }))
        .startupGraceSec,
    ).toBe(300);
  });

  it('preserves 0 as "no grace period"', () => {
    expect(
      resolveAlertingConfig(configWith({ ALERT_STARTUP_GRACE_SEC: '0' }))
        .startupGraceSec,
    ).toBe(0);
  });

  it('accepts MAINTENANCE as the documented flag', () => {
    expect(
      resolveAlertingConfig(configWith({ MAINTENANCE: 'true' }))
        .maintenanceMode,
    ).toBe(true);
  });

  it('also accepts the alerting-scoped alias', () => {
    expect(
      resolveAlertingConfig(configWith({ ALERT_MAINTENANCE_MODE: 'true' }))
        .maintenanceMode,
    ).toBe(true);
  });
});

describe('channel configuration', () => {
  it('leaves every webhook channel unconfigured by default', () => {
    const config = resolveAlertingConfig(configWith());

    expect(config.slackWebhookUrl).toBe('');
    expect(config.discordWebhookUrl).toBe('');
    expect(config.webhookUrl).toBe('');
  });

  it('reads each channel URL independently', () => {
    const config = resolveAlertingConfig(
      configWith({
        ALERT_SLACK_WEBHOOK_URL: 'https://slack.test/a',
        ALERT_DISCORD_WEBHOOK_URL: 'https://discord.test/b',
        ALERT_WEBHOOK_URL: 'https://sink.test/c',
      }),
    );

    expect(config.slackWebhookUrl).toBe('https://slack.test/a');
    expect(config.discordWebhookUrl).toBe('https://discord.test/b');
    expect(config.webhookUrl).toBe('https://sink.test/c');
  });
});

describe('alert links', () => {
  const rule = {
    name: 'queue_backlog',
    dashboardUrl: '/d/mator-bullmq?var-queue={{queue}}',
  };

  it('joins a rule-relative path onto the Grafana base URL', () => {
    // Rules never hardcode a hostname, so the same code points at staging
    // Grafana in staging and production Grafana in production.
    const links = resolveRuleLinkTemplates(
      rule,
      configWith({ ALERT_GRAFANA_BASE_URL: 'https://grafana.mator.uz' }),
    );

    expect(links.dashboard).toBe(
      'https://grafana.mator.uz/d/mator-bullmq?var-queue={{queue}}',
    );
  });

  it('tolerates a trailing slash on the base URL', () => {
    const links = resolveRuleLinkTemplates(
      rule,
      configWith({ ALERT_GRAFANA_BASE_URL: 'https://grafana.mator.uz/' }),
    );

    expect(links.dashboard).not.toContain('//d/');
  });

  it('yields no dashboard when no base URL is configured', () => {
    // A half-formed link like "/d/mator-bullmq" is useless in a chat message.
    expect(
      resolveRuleLinkTemplates(rule, configWith()).dashboard,
    ).toBeUndefined();
  });

  it('passes an absolute rule URL through untouched', () => {
    const links = resolveRuleLinkTemplates(
      { name: 'r', dashboardUrl: 'https://elsewhere.test/panel' },
      configWith({ ALERT_GRAFANA_BASE_URL: 'https://grafana.mator.uz' }),
    );

    expect(links.dashboard).toBe('https://elsewhere.test/panel');
  });

  it('lets a per-rule env var override the declared URL', () => {
    // A dashboard that moves can be re-pointed without a deploy — which matters
    // because a stale link is discovered when it is least convenient to fix.
    const links = resolveRuleLinkTemplates(
      rule,
      configWith({
        ALERT_GRAFANA_BASE_URL: 'https://grafana.mator.uz',
        ALERT_QUEUE_BACKLOG_DASHBOARD_URL: 'https://grafana.mator.uz/d/new',
      }),
    );

    expect(links.dashboard).toBe('https://grafana.mator.uz/d/new');
  });

  it('derives a runbook from the base URL and the rule name', () => {
    // Convention over configuration: writing the wiki page is enough.
    const links = resolveRuleLinkTemplates(
      rule,
      configWith({ ALERT_RUNBOOK_BASE_URL: 'https://wiki.mator.uz/runbooks' }),
    );

    expect(links.runbook).toBe('https://wiki.mator.uz/runbooks/queue-backlog');
  });

  it('prefers an explicitly declared runbook over the convention', () => {
    const links = resolveRuleLinkTemplates(
      { name: 'queue_backlog', runbookUrl: 'https://wiki.test/custom' },
      configWith({ ALERT_RUNBOOK_BASE_URL: 'https://wiki.mator.uz/runbooks' }),
    );

    expect(links.runbook).toBe('https://wiki.test/custom');
  });

  it('yields no runbook when nothing is configured', () => {
    expect(
      resolveRuleLinkTemplates(rule, configWith()).runbook,
    ).toBeUndefined();
  });
});

describe('renderUrlTemplate', () => {
  it('substitutes labels into a template', () => {
    // This is what makes one declaration serve every instance of a fan-out
    // rule: the link lands on the panel for the queue that actually broke.
    expect(
      renderUrlTemplate('https://g.test/d/q?var-queue={{queue}}', {
        queue: 'image-processing',
      }),
    ).toBe('https://g.test/d/q?var-queue=image-processing');
  });

  it('percent-encodes label values', () => {
    // A label reaching the URL verbatim could otherwise produce a broken link.
    expect(
      renderUrlTemplate('https://g.test/d/q?var-queue={{queue}}', {
        queue: 'a b&c',
      }),
    ).toBe('https://g.test/d/q?var-queue=a%20b%26c');
  });

  it('tolerates whitespace inside the placeholder', () => {
    expect(
      renderUrlTemplate('https://g.test/{{ queue }}', { queue: 'sms' }),
    ).toBe('https://g.test/sms');
  });

  it('invalidates the URL when a placeholder has no matching label', () => {
    // A link that 404s or shows the wrong panel costs MORE time than no link,
    // because it is trusted before it is checked.
    expect(
      renderUrlTemplate('https://g.test/d/q?var-queue={{queue}}', {
        provider: 'eskiz',
      }),
    ).toBeUndefined();
  });

  it('passes a template with no placeholders through', () => {
    expect(renderUrlTemplate('https://g.test/d/q', {})).toBe(
      'https://g.test/d/q',
    );
  });

  it('is undefined for an absent or blank template', () => {
    expect(renderUrlTemplate(undefined, {})).toBeUndefined();
    expect(renderUrlTemplate('   ', {})).toBeUndefined();
  });
});

describe('env parsing helpers', () => {
  it('positiveFloatEnv accepts decimals and rejects non-positive values', () => {
    expect(positiveFloatEnv('45.5', 1)).toBe(45.5);
    expect(positiveFloatEnv('0', 1)).toBe(1);
    expect(positiveFloatEnv('-2', 1)).toBe(1);
    expect(positiveFloatEnv(undefined, 1)).toBe(1);
  });

  it('nonNegativeIntEnv preserves 0, which is a meaningful setting', () => {
    // ALERT_RENOTIFY_MIN=0 means "never re-notify" and must survive parsing
    // rather than falling back to the default.
    expect(nonNegativeIntEnv('0', 30)).toBe(0);
    expect(nonNegativeIntEnv('45', 30)).toBe(45);
    expect(nonNegativeIntEnv('-1', 30)).toBe(30);
    expect(nonNegativeIntEnv(undefined, 30)).toBe(30);
  });
});
