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

  it('defaults the Android store link to the app package com.mator.myapp', () => {
    // app.json android.package — NOT the iOS bundle id (com.fotih12.mator),
    // which is a different identifier namespace and no Play listing.
    delete process.env.APP_ANDROID_STORE_URL; // the default, not an override
    const config = new MobileConfigService().getConfig();
    expect(config.android_store_url).toBe(
      'https://play.google.com/store/apps/details?id=com.mator.myapp',
    );
  });
});

describe('MobileConfigService support contacts', () => {
  const original = { ...process.env };
  const SUPPORT_VARS = ['APP_SUPPORT_PHONE', 'APP_SUPPORT_EMAIL', 'APP_SUPPORT_TELEGRAM'] as const;

  beforeEach(() => {
    for (const key of SUPPORT_VARS) delete process.env[key];
  });
  afterAll(() => {
    process.env = original;
  });

  it('serves every channel as null when unset', () => {
    expect(new MobileConfigService().getConfig().support).toEqual({
      phone: null,
      email: null,
      telegram_username: null,
    });
  });

  it('normalises the configured values', () => {
    process.env.APP_SUPPORT_PHONE = ' +998 (50) 203-03-18 ';
    process.env.APP_SUPPORT_EMAIL = 'matorinnovations@gmail.com';
    process.env.APP_SUPPORT_TELEGRAM = '@Mator_AutoParts';

    expect(new MobileConfigService().getConfig().support).toEqual({
      phone: '+998502030318',
      email: 'matorinnovations@gmail.com',
      telegram_username: 'Mator_AutoParts',
    });
  });

  it('adds the + to a bare international number and accepts a t.me link', () => {
    process.env.APP_SUPPORT_PHONE = '998502030318';
    process.env.APP_SUPPORT_TELEGRAM = 'https://t.me/Mator_AutoParts';

    const support = new MobileConfigService().getConfig().support;
    expect(support.phone).toBe('+998502030318');
    expect(support.telegram_username).toBe('Mator_AutoParts');
  });

  it('hides a malformed channel instead of serving it', () => {
    process.env.APP_SUPPORT_PHONE = 'call us';
    process.env.APP_SUPPORT_EMAIL = 'not-an-email';
    process.env.APP_SUPPORT_TELEGRAM = '@ab';

    expect(new MobileConfigService().getConfig().support).toEqual({
      phone: null,
      email: null,
      telegram_username: null,
    });
  });
});
