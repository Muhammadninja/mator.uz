import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  ALERT_STATE,
  AlertSeverity,
  type AlertNotification,
} from '../alerting.types';
import { DiscordAlertChannel } from './discord.channel';
import { GenericWebhookAlertChannel } from './generic-webhook.channel';
import { SlackAlertChannel } from './slack.channel';
import { TelegramAlertChannel } from './telegram.channel';
import { describeHttpError, genericAlertBody } from './webhook.channel';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * The channel abstraction exists so a new destination costs ~20 lines and no
 * change to any rule. These tests assert the shared contract every channel must
 * honour — the severity gate, the "unconfigured is inert" rule, and throwing on
 * failure so BullMQ retries.
 */

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const SOURCE = {
  version: '2.8.14',
  commit: '81e6fd3',
  host: 'backend-02',
  instance: 'worker-3',
  pid: 4242,
};

function notification(
  over: Partial<AlertNotification> = {},
): AlertNotification {
  return {
    dedupeKey: 'queue_backlog{queue="sms"}',
    fingerprint: 'A7F91B',
    state: ALERT_STATE.ACTIVE,
    rule: 'queue_backlog',
    severity: AlertSeverity.ERROR,
    labels: { queue: 'sms', environment: 'production' },
    values: { waiting: 150, threshold: 100 },
    title: 'Sms Queue Backlog',
    summary: 'sms queue backlog',
    links: {},
    source: SOURCE,
    firedAt: Date.UTC(2026, 6, 26, 14, 31),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.post.mockResolvedValue({ status: 200, data: 'ok' });
  // axios.isAxiosError is a real helper, not a jest mock — restore it.
  (mockedAxios as unknown as { isAxiosError: unknown }).isAxiosError = (
    err: unknown,
  ): boolean => Boolean((err as { isAxiosError?: boolean })?.isAxiosError);
});

describe('the AlertChannel contract', () => {
  const cases: [string, (env: Record<string, string>) => unknown, string][] = [
    [
      'slack',
      (env) => new SlackAlertChannel(configWith(env)),
      'ALERT_SLACK_WEBHOOK_URL',
    ],
    [
      'discord',
      (env) => new DiscordAlertChannel(configWith(env)),
      'ALERT_DISCORD_WEBHOOK_URL',
    ],
    [
      'webhook',
      (env) => new GenericWebhookAlertChannel(configWith(env)),
      'ALERT_WEBHOOK_URL',
    ],
  ];

  it.each(cases)(
    '%s is inert until its URL is configured',
    (_name, build, urlVar) => {
      const off = build({}) as { configured: boolean };
      const on = build({ [urlVar]: 'https://example.test/hook' }) as {
        configured: boolean;
      };

      // An unconfigured channel is never enqueued for, so it costs nothing and
      // never fills the failed set.
      expect(off.configured).toBe(false);
      expect(on.configured).toBe(true);
    },
  );

  it.each(cases)('%s honours its minimum severity', (name, build, urlVar) => {
    const channel = build({
      [urlVar]: 'https://example.test/hook',
      [`ALERT_${name.toUpperCase()}_MIN_SEVERITY`]: 'CRITICAL',
    }) as { accepts: (n: AlertNotification) => boolean };

    expect(
      channel.accepts(notification({ severity: AlertSeverity.ERROR })),
    ).toBe(false);
    expect(
      channel.accepts(notification({ severity: AlertSeverity.CRITICAL })),
    ).toBe(true);
  });

  it.each(cases)(
    '%s throws on an HTTP failure so BullMQ retries',
    async (_name, build, urlVar) => {
      const channel = build({ [urlVar]: 'https://example.test/hook' }) as {
        deliver: (n: AlertNotification) => Promise<void>;
      };
      mockedAxios.post.mockRejectedValue(
        Object.assign(new Error('Request failed'), {
          isAxiosError: true,
          response: { status: 500, data: 'server error' },
        }),
      );

      // Swallowing here would silently drop the alert.
      await expect(channel.deliver(notification())).rejects.toThrow(/500/);
    },
  );
});

describe('SlackAlertChannel', () => {
  const env = { ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' };

  it('posts Block Kit blocks plus a fallback text', async () => {
    await new SlackAlertChannel(configWith(env)).deliver(notification());

    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toBe(env.ALERT_SLACK_WEBHOOK_URL);

    const payload = body as { text: string; blocks: unknown[] };
    // `text` is what Slack shows in the push preview; omitting it yields a
    // notification that reads only "New message".
    expect(payload.text).toContain('Sms Queue Backlog');
    expect(payload.blocks.length).toBeGreaterThan(0);
  });

  it('renders values as a field grid', async () => {
    await new SlackAlertChannel(configWith(env)).deliver(notification());

    const body = mockedAxios.post.mock.calls[0][1] as {
      blocks: { type: string; fields?: { text: string }[] }[];
    };
    const fieldBlock = body.blocks.find((b) => b.fields !== undefined);

    expect(fieldBlock?.fields?.map((f) => f.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('150'),
        expect.stringContaining('100'),
      ]),
    );
  });

  it('colours the attachment by severity', async () => {
    const channel = new SlackAlertChannel(configWith(env));

    await channel.deliver(notification({ severity: AlertSeverity.CRITICAL }));
    const critical = mockedAxios.post.mock.calls[0][1] as {
      attachments: { color: string }[];
    };

    await channel.deliver(notification({ severity: AlertSeverity.INFO }));
    const info = mockedAxios.post.mock.calls[1][1] as {
      attachments: { color: string }[];
    };

    expect(critical.attachments[0].color).not.toBe(info.attachments[0].color);
  });
});

describe('DiscordAlertChannel', () => {
  const env = {
    ALERT_DISCORD_WEBHOOK_URL: 'https://discord.test/api/webhooks/x',
  };

  it('posts an embed with inline value fields', async () => {
    await new DiscordAlertChannel(configWith(env)).deliver(notification());

    const body = mockedAxios.post.mock.calls[0][1] as {
      embeds: {
        title: string;
        color: number;
        fields: { name: string; value: string; inline: boolean }[];
      }[];
    };

    expect(body.embeds[0].title).toContain('Error');
    expect(body.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Waiting', value: '150' }),
      ]),
    );
    expect(typeof body.embeds[0].color).toBe('number');
  });
});

describe('link rendering per channel', () => {
  const LINKS = {
    dashboard: 'https://grafana.mator.uz/d/mator-bullmq?var-queue=sms',
    runbook: 'https://wiki.mator.uz/runbooks/queue-backlog',
  };

  it('Slack renders links as tappable buttons', async () => {
    // Buttons, not a bare URL to long-press — this is read on a phone during
    // an incident.
    await new SlackAlertChannel(
      configWith({ ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' }),
    ).deliver(notification({ links: LINKS }));

    const body = mockedAxios.post.mock.calls[0][1] as {
      blocks: { type: string; elements?: { text?: unknown; url?: string }[] }[];
    };
    const actions = body.blocks.find((b) => b.type === 'actions');

    expect(actions?.elements?.map((e) => e.url)).toEqual([
      LINKS.dashboard,
      LINKS.runbook,
    ]);
  });

  it('Discord renders links as full-width embed fields', async () => {
    // A URL in an inline column wraps into unreadable fragments.
    await new DiscordAlertChannel(
      configWith({
        ALERT_DISCORD_WEBHOOK_URL: 'https://discord.test/api/webhooks/x',
      }),
    ).deliver(notification({ links: LINKS }));

    const body = mockedAxios.post.mock.calls[0][1] as {
      embeds: { fields: { name: string; value: string; inline: boolean }[] }[];
    };
    const linkFields = body.embeds[0].fields.filter((f) => !f.inline);

    expect(linkFields.map((f) => f.name)).toEqual(['Dashboard', 'Runbook']);
    expect(linkFields[0].value).toContain(LINKS.dashboard);
  });

  it('every channel omits links when the alert has none', async () => {
    await new SlackAlertChannel(
      configWith({ ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' }),
    ).deliver(notification());

    const body = mockedAxios.post.mock.calls[0][1] as {
      blocks: { type: string }[];
    };

    expect(body.blocks.some((b) => b.type === 'actions')).toBe(false);
  });
});

describe('GenericWebhookAlertChannel', () => {
  const env = { ALERT_WEBHOOK_URL: 'https://sink.test/alerts' };

  it('posts a Prometheus-shaped JSON body', async () => {
    // Shaped so an Alertmanager-compatible receiver or a PagerDuty proxy needs
    // no translation layer.
    await new GenericWebhookAlertChannel(configWith(env)).deliver(
      notification(),
    );

    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({
      status: 'firing',
      rule: 'queue_backlog',
      severity: 'ERROR',
      labels: { queue: 'sms', environment: 'production' },
      values: { waiting: 150, threshold: 100 },
    });
  });

  it('marks a resolution as resolved', async () => {
    await new GenericWebhookAlertChannel(configWith(env)).deliver(
      notification({ state: ALERT_STATE.RESOLVED }),
    );

    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({
      status: 'resolved',
    });
  });

  it('sends the configured Authorization header', async () => {
    await new GenericWebhookAlertChannel(
      configWith({ ...env, ALERT_WEBHOOK_AUTH_HEADER: 'Bearer secret' }),
    ).deliver(notification());

    const config = mockedAxios.post.mock.calls[0][2] as {
      headers: Record<string, string>;
    };
    expect(config.headers.Authorization).toBe('Bearer secret');
  });

  it('omits the header when none is configured', async () => {
    await new GenericWebhookAlertChannel(configWith(env)).deliver(
      notification(),
    );

    const config = mockedAxios.post.mock.calls[0][2] as {
      headers: Record<string, string>;
    };
    expect(config.headers.Authorization).toBeUndefined();
  });
});

describe('TelegramAlertChannel', () => {
  it('is inert without both a token and a chat id', () => {
    expect(new TelegramAlertChannel(configWith()).configured).toBe(false);
    expect(
      new TelegramAlertChannel(configWith({ TELEGRAM_BOT_TOKEN: 't' }))
        .configured,
    ).toBe(false);
    expect(
      new TelegramAlertChannel(
        configWith({
          TELEGRAM_BOT_TOKEN: 't',
          ALERT_TELEGRAM_CHAT_ID: '-100',
        }),
      ).configured,
    ).toBe(true);
  });

  it('honours ALERT_TELEGRAM_MIN_SEVERITY', () => {
    const channel = new TelegramAlertChannel(
      configWith({
        TELEGRAM_BOT_TOKEN: 't',
        ALERT_TELEGRAM_CHAT_ID: '-100',
        ALERT_TELEGRAM_MIN_SEVERITY: 'ERROR',
      }),
    );

    expect(
      channel.accepts(notification({ severity: AlertSeverity.WARNING })),
    ).toBe(false);
    expect(
      channel.accepts(notification({ severity: AlertSeverity.ERROR })),
    ).toBe(true);
  });
});

describe('genericAlertBody', () => {
  it('includes the incident duration when present', () => {
    expect(
      genericAlertBody(notification({ activeForMs: 90_000 })),
    ).toMatchObject({ activeForMs: 90_000 });
  });

  it('omits the duration when absent', () => {
    expect(genericAlertBody(notification())).not.toHaveProperty('activeForMs');
  });
});

describe('describeHttpError', () => {
  it('surfaces the HTTP status and the provider body', () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 404, data: 'no_such_hook' },
    });

    // "HTTP 404 — no_such_hook" tells an operator it is a bad URL; a raw axios
    // dump does not.
    expect(describeHttpError(err)).toBe('HTTP 404 — no_such_hook');
  });

  it('falls back to the message for a non-HTTP failure', () => {
    expect(describeHttpError(new Error('socket hang up'))).toBe(
      'socket hang up',
    );
  });
});
