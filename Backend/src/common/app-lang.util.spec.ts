// Tests for the interface-language vocabulary: enum ↔ wire conversion, parsing
// an untrusted code, and the category name-resolution rule every consumer
// (seller bot, buyer grid, admin console) shares.

import { BotLanguage } from '@prisma/client';
import {
  APP_LANGS,
  DEFAULT_APP_LANG,
  localizedCategoryName,
  parseAppLang,
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
