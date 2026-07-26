import {
  escapeHtml,
  formatUtc,
  humanizeKey,
  renderAlertMessage,
  renderPlainMessage,
  severityEmoji,
} from './alert-message';
import {
  ALERT_STATE,
  AlertSeverity,
  FINGERPRINT_LENGTH,
  alertFingerprint,
  formatDuration,
  type AlertNotification,
} from './alerting.types';

/**
 * The rendered message IS the product of this module — an operator reads it on
 * a phone at 3am. These tests pin the wire format so a refactor cannot quietly
 * degrade readability.
 */

// 2026-07-26 14:31 UTC
const FIRED_AT = Date.UTC(2026, 6, 26, 14, 31, 7);

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
    dedupeKey:
      'queue_backlog{environment="production",queue="image-processing"}',
    fingerprint: 'A7F91B',
    state: ALERT_STATE.ACTIVE,
    rule: 'queue_backlog',
    severity: AlertSeverity.CRITICAL,
    labels: { queue: 'image-processing', environment: 'production' },
    values: { waiting: 186, threshold: 100 },
    title: 'Image Processing Queue Backlog',
    summary: 'image processing queue backlog',
    source: SOURCE,
    firedAt: FIRED_AT,
    ...over,
  };
}

/** Strip HTML tags so the test asserts the text an operator actually reads. */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

describe('renderAlertMessage', () => {
  it('renders a critical alert with severity, values and labels', () => {
    const text = plain(renderAlertMessage(notification(), 'Production'));

    expect(text).toBe(
      [
        '🚨 Critical · Mator Production',
        '',
        'Image Processing Queue Backlog [A7F91B]',
        '',
        'Waiting: 186',
        'Threshold: 100',
        '',
        'queue=image-processing · environment=production',
        '',
        'Build: v2.8.14 · 81e6fd3',
        'Source: backend-02 · worker-3 · pid 4242',
        '',
        'Time:',
        '2026-07-26 14:31 UTC',
      ].join('\n'),
    );
  });

  describe('fingerprint', () => {
    it('sits on the title line, where a collapsed preview still shows it', () => {
      // That is what makes "look at A7F91B" work without opening the message.
      const text = plain(renderAlertMessage(notification(), 'Production'));

      expect(text).toContain('Image Processing Queue Backlog [A7F91B]');
    });

    it('is derived from the dedupe key, so it survives every re-notification', () => {
      // Stable identity of the CONDITION, not of one message — a random id per
      // notification could not be quoted across a multi-hour incident.
      const key = 'queue_backlog{environment="production",queue="sms"}';

      expect(alertFingerprint(key)).toBe(alertFingerprint(key));
      expect(alertFingerprint(key)).toHaveLength(FINGERPRINT_LENGTH);
      expect(alertFingerprint(key)).toMatch(/^[0-9A-F]+$/);
    });

    it('differs between distinct alerts', () => {
      expect(alertFingerprint('queue_backlog{queue="sms"}')).not.toBe(
        alertFingerprint('queue_backlog{queue="image-processing"}'),
      );
    });
  });

  describe('build and source provenance', () => {
    it('appends build and host on ERROR and above', () => {
      // "Is this the new release or the old one?" is the first question after a
      // deploy — answering it in the message removes a lookup from the incident.
      const text = plain(
        renderAlertMessage(
          notification({ severity: AlertSeverity.ERROR }),
          'Production',
        ),
      );

      expect(text).toContain('Build: v2.8.14 · 81e6fd3');
      expect(text).toContain('Source: backend-02 · worker-3 · pid 4242');
    });

    it('omits it on WARNING, which never prompts that question', () => {
      // Appending four lines of provenance to every routine warning is how a
      // message stops being scannable.
      const text = plain(
        renderAlertMessage(
          notification({ severity: AlertSeverity.WARNING }),
          'Production',
        ),
      );

      expect(text).not.toContain('Build:');
    });

    it('always includes it on a resolution', () => {
      // Knowing which build recovered is as useful as knowing which one broke.
      const text = plain(
        renderAlertMessage(
          notification({
            state: ALERT_STATE.RESOLVED,
            severity: AlertSeverity.INFO,
          }),
          'Production',
        ),
      );

      expect(text).toContain('Build: v2.8.14');
    });

    it('omits unknown components rather than printing placeholders', () => {
      // A local run should not print "commit: unknown" noise.
      const text = plain(
        renderAlertMessage(
          notification({
            severity: AlertSeverity.CRITICAL,
            source: {
              version: '0.0.1',
              commit: '',
              host: 'laptop',
              instance: '',
              pid: 99,
            },
          }),
          'Production',
        ),
      );

      expect(text).toContain('Build: v0.0.1');
      expect(text).toContain('Source: laptop · pid 99');
      expect(text).not.toContain('· ·');
    });
  });

  it('leads with a distinct emoji and name per severity', () => {
    const severities: [AlertSeverity, string][] = [
      [AlertSeverity.INFO, '🔵 Info'],
      [AlertSeverity.WARNING, '🟡 Warning'],
      [AlertSeverity.ERROR, '🔴 Error'],
      [AlertSeverity.CRITICAL, '🚨 Critical'],
    ];

    for (const [severity, expected] of severities) {
      const text = plain(
        renderAlertMessage(notification({ severity }), 'Production'),
      );
      // Named as well as coloured: emoji alone is ambiguous in a notification
      // preview and unreadable to a screen reader.
      expect(text.startsWith(expected)).toBe(true);
    }
  });

  it('shows the incident duration on a re-notification', () => {
    // The whole point of re-notification: a bare repeat reads as a duplicate,
    // a stated duration reads as an escalating incident.
    const text = plain(
      renderAlertMessage(
        notification({
          renotification: true,
          activeForMs: 3 * 60 * 60 * 1000 + 25 * 60 * 1000,
        }),
        'Production',
      ),
    );

    expect(text).toContain('Still active — 3h 25m');
  });

  it('omits the duration line on the first notification', () => {
    const text = plain(renderAlertMessage(notification(), 'Production'));

    expect(text).not.toContain('Still active');
  });

  it('renders a resolution with how long the incident lasted', () => {
    const text = plain(
      renderAlertMessage(
        notification({
          state: ALERT_STATE.RESOLVED,
          severity: AlertSeverity.INFO,
          values: { current: 18, threshold: 100 },
          activeForMs: 45 * 60 * 1000,
        }),
        'Production',
      ),
    );

    expect(text).toContain('✅ Resolved · Mator Production');
    expect(text).toContain(
      'Image processing queue backlog has returned to normal.',
    );
    expect(text).toContain('Was active for: 45m');
    // The RECOVERED value, not the one that tripped the alert.
    expect(text).toContain('Current: 18');
    expect(text).toContain('Threshold: 100');
  });

  it('renders the SMS failure example', () => {
    const text = plain(
      renderAlertMessage(
        notification({
          rule: 'sms_failures',
          title: 'SMS Failures',
          labels: { provider: 'eskiz', environment: 'production' },
          values: { failures_5min: 27, threshold: 10 },
        }),
        'Production',
      ),
    );

    expect(text).toContain('SMS Failures');
    expect(text).toContain('Failures 5min: 27');
    expect(text).toContain('provider=eskiz');
  });

  it('reflects the configured environment label', () => {
    expect(plain(renderAlertMessage(notification(), 'Staging'))).toContain(
      'Mator Staging',
    );
  });

  it('renders cleanly with no values and no labels', () => {
    const text = plain(
      renderAlertMessage(
        notification({
          state: ALERT_STATE.RESOLVED,
          values: {},
          labels: {},
          activeForMs: undefined,
        }),
        'Production',
      ),
    );

    expect(text).toContain('✅ Resolved');
    // No stray blank-line block where the values would have been.
    expect(text).not.toContain('\n\n\n');
  });

  it('escapes values that would otherwise break Telegram HTML parsing', () => {
    // Provider error strings are interpolated verbatim and routinely contain
    // angle brackets — an unescaped one makes the send fail outright.
    const text = renderAlertMessage(
      notification({
        values: { error: 'connect ECONNREFUSED <db:5432>' },
      }),
      'Production',
    );

    expect(text).toContain('&lt;db:5432&gt;');
    expect(text).not.toContain('<db:5432>');
  });
});

describe('renderPlainMessage', () => {
  it('renders the same content with no markup, for Slack/Discord', () => {
    const text = renderPlainMessage(notification(), 'Production');

    expect(text).toContain('🚨 Critical · Mator Production');
    expect(text).toContain('Waiting: 186');
    expect(text).not.toContain('<b>');
  });
});

describe('formatDuration', () => {
  it('renders hours and minutes for a long incident', () => {
    expect(formatDuration(3 * 60 * 60 * 1000 + 25 * 60 * 1000)).toBe('3h 25m');
  });

  it('drops the hour component under an hour', () => {
    expect(formatDuration(45 * 60 * 1000)).toBe('45m');
  });

  it('falls back to seconds under a minute', () => {
    expect(formatDuration(30_000)).toBe('30s');
  });

  it('never renders a negative duration', () => {
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('severityEmoji', () => {
  it('is distinct per level, so severity reads at a glance', () => {
    const emoji = [
      AlertSeverity.INFO,
      AlertSeverity.WARNING,
      AlertSeverity.ERROR,
      AlertSeverity.CRITICAL,
    ].map(severityEmoji);

    expect(new Set(emoji).size).toBe(4);
  });
});

describe('formatUtc', () => {
  it('formats as YYYY-MM-DD HH:MM UTC', () => {
    expect(formatUtc(FIRED_AT)).toBe('2026-07-26 14:31 UTC');
  });

  it('is always UTC regardless of the host timezone', () => {
    // Correlating an alert against UTC logs and Grafana is the whole point;
    // a message that shifts with the server's TZ is worse than no timestamp.
    expect(formatUtc(Date.UTC(2026, 0, 1, 0, 5))).toBe('2026-01-01 00:05 UTC');
  });
});

describe('humanizeKey', () => {
  it('turns camelCase and snake_case value keys into readable labels', () => {
    expect(humanizeKey('waitingJobs')).toBe('Waiting jobs');
    expect(humanizeKey('checked_for')).toBe('Checked for');
    expect(humanizeKey('p95')).toBe('P95');
  });
});

describe('escapeHtml', () => {
  it('escapes the three characters Telegram HTML treats as special', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes ampersands before angle brackets (no double-escaping)', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
