import { hostname } from 'node:os';
import type { ConfigService } from '@nestjs/config';
import {
  UNKNOWN_VERSION,
  resolveAlertSource,
  resolveInstanceLabel,
  shortCommit,
} from './build-info';

/**
 * Build provenance answers "is this the new release or the old one?" inside the
 * alert itself. These tests pin the resolution order — env first, because in a
 * real deploy that is where CI knows the truth — and the graceful degradation,
 * because a missing version must never stop the process from booting.
 */

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

describe('resolveAlertSource', () => {
  it('prefers APP_VERSION over package.json', () => {
    // The container tag / CI-injected version is the deployed truth; the
    // package.json version is only a development fallback.
    expect(
      resolveAlertSource(configWith({ APP_VERSION: '2.8.14' }), {}).version,
    ).toBe('2.8.14');
  });

  it('falls back to the package.json version', () => {
    // A plain `npm start` still reports something meaningful.
    const version = resolveAlertSource(configWith(), {}).version;

    expect(version).not.toBe('');
    expect(version).toMatch(/^\d+\.\d+\.\d+$|^unknown$/);
  });

  it('reads the commit from GIT_COMMIT and shortens it', () => {
    const source = resolveAlertSource(
      configWith({ GIT_COMMIT: '81e6fd3a9c2b4e5f6071829384756abcdef01234' }),
      {},
    );

    expect(source.commit).toBe('81e6fd3');
  });

  it('picks up a CI-provided commit with no configuration', () => {
    // Several PaaS providers set these, so a deploy from one reports its commit
    // without anyone remembering to wire GIT_COMMIT.
    expect(
      resolveAlertSource(configWith(), { SOURCE_VERSION: 'abcdef1234567' })
        .commit,
    ).toBe('abcdef1');
  });

  it('leaves the commit empty when genuinely unknown', () => {
    // Rendered as an omitted line rather than "commit: unknown" noise.
    expect(resolveAlertSource(configWith(), {}).commit).toBe('');
  });

  it('defaults the host to the machine hostname', () => {
    expect(resolveAlertSource(configWith(), {}).host).toBe(hostname());
  });

  it('lets ALERT_HOST_LABEL override an unrecognisable container id', () => {
    expect(
      resolveAlertSource(configWith({ ALERT_HOST_LABEL: 'backend-02' }), {})
        .host,
    ).toBe('backend-02');
  });

  it('includes the pid, which disambiguates two instances on one host', () => {
    expect(resolveAlertSource(configWith(), {}).pid).toBe(process.pid);
  });

  it('never reports an empty version', () => {
    expect(
      resolveAlertSource(configWith({ APP_VERSION: '   ' }), {}).version,
    ).not.toBe('');
  });
});

describe('resolveInstanceLabel', () => {
  it('renders the PM2 worker index', () => {
    expect(resolveInstanceLabel({ NODE_APP_INSTANCE: '3' })).toBe('worker-3');
  });

  it('falls back to pm_id', () => {
    expect(resolveInstanceLabel({ pm_id: '1' })).toBe('worker-1');
  });

  it('is empty when not running under PM2', () => {
    // So the field is omitted from the message rather than showing a
    // meaningless placeholder.
    expect(resolveInstanceLabel({})).toBe('');
    expect(resolveInstanceLabel({ NODE_APP_INSTANCE: '  ' })).toBe('');
  });
});

describe('shortCommit', () => {
  it('trims a full SHA to its short form', () => {
    expect(shortCommit('81e6fd3a9c2b4e5f6071829384756abcdef01234')).toBe(
      '81e6fd3',
    );
  });

  it('passes through an already-short SHA', () => {
    expect(shortCommit('81e6fd3')).toBe('81e6fd3');
  });

  it('leaves a non-SHA label untouched', () => {
    // Some deploys tag with a release name rather than a commit.
    expect(shortCommit('release-2026-07-26')).toBe('release-2026-07-26');
  });

  it('is empty for a missing value', () => {
    expect(shortCommit(undefined)).toBe('');
    expect(shortCommit('  ')).toBe('');
  });
});

describe('UNKNOWN_VERSION', () => {
  it('is the sentinel used when nothing can be determined', () => {
    expect(UNKNOWN_VERSION).toBe('unknown');
  });
});
