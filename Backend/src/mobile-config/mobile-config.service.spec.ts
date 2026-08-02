// Unit tests for MobileConfigService — GET /v1/app/config.
//
// The legal URLs are a RELEASE BLOCKER surface: App Store Connect requires a
// Privacy Policy URL and the app links to both documents from its legal screen.
// The contract these tests pin is that the backend never invents legal content:
// an unset variable reads as null ("not supplied yet"), never as a placeholder
// the app could present as a final, approved policy.

import { MobileConfigService } from './mobile-config.service';

const LEGAL_VARS = ['APP_PRIVACY_POLICY_URL', 'APP_TERMS_URL'] as const;

describe('MobileConfigService.getConfig', () => {
  const original = { ...process.env };

  beforeEach(() => {
    for (const key of LEGAL_VARS) delete process.env[key];
  });
  afterAll(() => {
    process.env = original;
  });

  it('reports both legal URLs as null when unset — never a placeholder', () => {
    const config = new MobileConfigService().getConfig();

    expect(config.privacy_policy_url).toBeNull();
    expect(config.terms_url).toBeNull();
  });

  it('serves the configured legal URLs when the owner supplies them', () => {
    process.env.APP_PRIVACY_POLICY_URL = 'https://mator.uz/legal/privacy';
    process.env.APP_TERMS_URL = 'https://mator.uz/legal/terms';

    const config = new MobileConfigService().getConfig();

    expect(config.privacy_policy_url).toBe('https://mator.uz/legal/privacy');
    expect(config.terms_url).toBe('https://mator.uz/legal/terms');
  });

  it('treats a blank/whitespace value as unset', () => {
    process.env.APP_PRIVACY_POLICY_URL = '   ';
    process.env.APP_TERMS_URL = '';

    const config = new MobileConfigService().getConfig();

    // An operator half-filling the env must not ship an empty-string link.
    expect(config.privacy_policy_url).toBeNull();
    expect(config.terms_url).toBeNull();
  });

  it('keeps the existing force-update contract intact', () => {
    const config = new MobileConfigService().getConfig();

    // Defaults stay safe: nothing is ever force-updated until set explicitly.
    expect(config.min_supported_version).toBe('0.0.0');
    expect(config.android_store_url).toContain('play.google.com');
  });
});
