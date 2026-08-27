// Tests for the interface-language vocabulary: enum ↔ wire conversion, parsing
// an untrusted code, and the category name-resolution rule every consumer
// (seller bot, buyer grid, admin console) shares.

import { BotLanguage } from '@prisma/client';
import {
  APP_LANGS,
  DEFAULT_APP_LANG,
  localizedCategoryName,
  parseAcceptLanguage,
  parseAppLang,
  resolveRequestLang,
  toAppLang,
  toBotLanguage,
} from './app-lang.util';

describe('language conversion', () => {
  it.each([
    ['ru', BotLanguage.RU],
    ['uz', BotLanguage.UZ],
    ['en', BotLanguage.EN],
  ] as const)('round-trips %s through the stored enum', (lang, stored) => {
    expect(toBotLanguage(lang)).toBe(stored);
    expect(toAppLang(stored)).toBe(lang);
  });

  it('treats an unset language as the default (a seller who never chose)', () => {
    expect(toAppLang(null)).toBe(DEFAULT_APP_LANG);
    expect(toAppLang(undefined)).toBe(DEFAULT_APP_LANG);
  });

  it('offers exactly the three shipped languages, in menu order', () => {
    expect(APP_LANGS).toEqual(['ru', 'uz', 'en']);
  });
});

describe('parseAppLang', () => {
  it.each(['ru', 'UZ', ' en ', 'Ru'])('accepts %p', (raw) => {
    expect(parseAppLang(raw)).toBe(raw.trim().toLowerCase());
  });

  it.each([
    ['an unsupported language', 'de'],
    ['Uzbek Cyrillic, which has no button', 'uz_cyr'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s rather than guessing', (_label, raw) => {
    expect(parseAppLang(raw)).toBeNull();
  });
});

describe('localizedCategoryName', () => {
  const category = {
    name: 'Brakes',
    nameRu: 'Тормоза',
    nameUz: 'Tormozlar',
    nameEn: 'Brakes',
  };

  it.each([
    ['ru', 'Тормоза'],
    ['uz', 'Tormozlar'],
    ['en', 'Brakes'],
  ] as const)('renders the %s name', (lang, expected) => {
    expect(localizedCategoryName(category, lang)).toBe(expected);
  });

  it('falls back down the chain rather than rendering an empty label', () => {
    // A row read through a partial select, or one holding a blank value: the
    // button must still say something.
    expect(localizedCategoryName({ ...category, nameUz: '  ' }, 'uz')).toBe(
      'Тормоза',
    );
    expect(localizedCategoryName({ nameEn: 'Filters' }, 'ru')).toBe('Filters');
    expect(localizedCategoryName({ name: 'Legacy' }, 'uz')).toBe('Legacy');
  });

  it('returns an empty string when a row carries no name at all', () => {
    expect(localizedCategoryName({}, 'en')).toBe('');
  });
});

/**
 * `Accept-Language` is how a buyer request states its language — the header the
 * mobile app already sends, rather than a second `?lang=` mechanism. These
 * tests pin the parts of RFC 9110 §12.5.4 that can change the answer across a
 * three-language set, plus the guarantee that MATTERS operationally: a missing
 * or hostile header costs a fallback, never a 500 or a blank label.
 */
describe('parseAcceptLanguage', () => {
  it.each([
    ['a bare code', 'ru', 'ru'],
    ['Uzbek', 'uz', 'uz'],
    ['English', 'en', 'en'],
  ])('resolves %s', (_label, header, expected) => {
    expect(parseAcceptLanguage(header)).toBe(expected);
  });

  // The forms a real browser/phone actually sends — region and script subtags
  // must widen to the language, not fall through to the default.
  it.each([
    ['ru-RU', 'ru'],
    ['uz-UZ', 'uz'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['uz-Latn-UZ', 'uz'],
    ['RU-ru', 'ru'],
    ['  en  ', 'en'],
  ])('widens the regional tag %p to %p', (header, expected) => {
    expect(parseAcceptLanguage(header)).toBe(expected);
  });

  it('picks the first supported language in a multi-value header', () => {
    expect(parseAcceptLanguage('uz,ru;q=0.8')).toBe('uz');
    expect(parseAcceptLanguage('ru,uz;q=0.8')).toBe('ru');
  });

  it('skips unsupported languages ahead of a supported one', () => {
    expect(parseAcceptLanguage('de-DE,fr;q=0.9,uz;q=0.5')).toBe('uz');
  });

  it('honours q-weights over listed order', () => {
    expect(parseAcceptLanguage('ru;q=0.2,uz;q=0.9')).toBe('uz');
    expect(parseAcceptLanguage('en;q=0.1,ru;q=0.4,uz;q=0.3')).toBe('ru');
  });

  it('keeps the client’s order for equal weights (a stable sort)', () => {
    expect(parseAcceptLanguage('uz;q=0.5,ru;q=0.5')).toBe('uz');
    expect(parseAcceptLanguage('ru;q=0.5,uz;q=0.5')).toBe('ru');
  });

  // q=0 means "explicitly NOT this one". Ranking it last instead of dropping it
  // is the bug that serves a language the client just refused.
  it('drops a q=0 tag rather than ranking it last', () => {
    expect(parseAcceptLanguage('ru;q=0')).toBeNull();
    expect(parseAcceptLanguage('ru;q=0,uz')).toBe('uz');
  });

  it('answers the platform default for the * wildcard', () => {
    expect(parseAcceptLanguage('*')).toBe(DEFAULT_APP_LANG);
    expect(parseAcceptLanguage('de,*')).toBe(DEFAULT_APP_LANG);
  });

  it.each([
    ['an absent header', undefined],
    ['a null header', null],
    ['an empty header', ''],
    ['whitespace only', '   '],
    ['only unsupported languages', 'de-DE,fr-FR'],
    ['Uzbek Cyrillic, which the apps do not ship', 'uz_cyr'],
    ['a non-string', 42 as unknown as string],
  ])('returns null for %s, leaving the fallback to the caller', (_l, header) => {
    expect(parseAcceptLanguage(header)).toBeNull();
  });

  it.each([
    ['a malformed weight', 'ru;q=abc'],
    ['a stray semicolon', 'ru;'],
    ['empty list entries', 'ru,,,'],
    ['an unknown parameter', 'ru;foo=bar'],
    ['junk punctuation', ';;;,,,'],
  ])('never throws on %s', (_label, header) => {
    expect(() => parseAcceptLanguage(header)).not.toThrow();
  });

  it('treats a malformed weight as the default q=1, not as a rejection', () => {
    expect(parseAcceptLanguage('ru;q=abc')).toBe('ru');
  });
});

describe('resolveRequestLang', () => {
  it('returns the requested language when it is one we ship', () => {
    expect(resolveRequestLang('uz-UZ')).toBe('uz');
    expect(resolveRequestLang('en-US')).toBe('en');
  });

  // The operational guarantee: no endpoint has to invent a fallback, and no
  // category label can come back blank because a header was missing.
  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['an unsupported language', 'de-DE'],
    ['garbage', ';;;'],
  ])('falls back to the default for %s', (_label, header) => {
    expect(resolveRequestLang(header)).toBe(DEFAULT_APP_LANG);
    expect(APP_LANGS).toContain(resolveRequestLang(header));
  });

  it('always returns a supported language, whatever it is given', () => {
    for (const header of ['ru', 'zz', '', '*', 'uz;q=0', 'en-US,de']) {
      expect(APP_LANGS).toContain(resolveRequestLang(header));
    }
  });
});
