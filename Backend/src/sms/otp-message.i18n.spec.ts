// Unit tests for the OTP SMS copy. The bodies here are the AGGREGATOR-APPROVED
// templates — an unapproved body is rejected at send time — so these assertions
// are deliberately verbatim: they fail the moment a character drifts.

import {
  DEFAULT_SMS_LANG,
  OTP_SMS_TEMPLATES,
  SMS_LANGS,
  isSmsLang,
  renderOtpMessage,
  resolveSmsLang,
} from './otp-message.i18n';

describe('OTP SMS templates', () => {
  it('renders the approved body verbatim in every language', () => {
    expect(renderOtpMessage('123456', 'en')).toBe(
      'Mator app: verification code for login 123456. Do not share it with anyone. Valid for 5 minutes.',
    );
    expect(renderOtpMessage('123456', 'ru')).toBe(
      'Prilojeniye Mator: kod podtverzhdeniya dlya vhoda 123456. Nikomu ne peredavayte. Srok deystviya 5 minut.',
    );
    expect(renderOtpMessage('123456', 'uz')).toBe(
      'Mator ilovasi: tasdiqlash kodingiz 123456. Hech kimga bermang. Amal qilish muddati 5 daqiqa.',
    );
  });

  it('leaves no placeholder behind and covers the whole supported set', () => {
    for (const lang of SMS_LANGS) {
      expect(OTP_SMS_TEMPLATES[lang]).toContain('{code}');
      expect(renderOtpMessage('000000', lang)).not.toContain('{code}');
    }
  });

  it('keeps every body inside one GSM-7 part (160 chars)', () => {
    // Latin-only copy on purpose: a Cyrillic body switches the SMS to UCS-2 and
    // doubles the billed parts. This is the regression guard for that decision.
    for (const lang of SMS_LANGS) {
      const body = renderOtpMessage('123456', lang);
      expect(body).toMatch(/^[\x20-\x7E]+$/);
      expect(body.length).toBeLessThanOrEqual(160);
    }
  });
});

describe('resolveSmsLang', () => {
  it('passes through a supported tag', () => {
    expect(resolveSmsLang('en')).toBe('en');
    expect(resolveSmsLang('ru')).toBe('ru');
    expect(resolveSmsLang('uz')).toBe('uz');
  });

  it('normalizes case, whitespace and locale/script subtags', () => {
    expect(resolveSmsLang(' RU ')).toBe('ru');
    expect(resolveSmsLang('en_US')).toBe('en');
    expect(resolveSmsLang('ru-RU')).toBe('ru');
    expect(resolveSmsLang('uz-Latn-UZ')).toBe('uz');
    // The chat i18n util's alphabet tags (src/common/i18n.util.ts) fold in too.
    expect(resolveSmsLang('uz_cyr')).toBe('uz');
  });

  it('falls back to uz for anything unknown or absent', () => {
    expect(DEFAULT_SMS_LANG).toBe('uz');
    const unsupported: (string | null | undefined)[] = [
      undefined,
      null,
      '',
      '   ',
      'de',
      'kk',
      'xx-YY',
      '42',
    ];
    for (const input of unsupported) {
      expect(resolveSmsLang(input)).toBe('uz');
    }
  });

  it('never trusts a non-string (a JSON body can carry anything)', () => {
    for (const input of [42, {}, [], true]) {
      expect(resolveSmsLang(input as unknown as string)).toBe('uz');
      expect(isSmsLang(input)).toBe(false);
    }
  });
});
