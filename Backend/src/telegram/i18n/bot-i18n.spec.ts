// Tests for the seller bot's translation layer: dictionary completeness and
// parity, placeholder interpolation, and the language menu's payloads.
//
// The parity tests are the point of this file. A missing KEY is already a
// compile error (each dictionary implements `BotStrings`), but a translation
// that silently drops a `{count}` slot, or is copy-pasted verbatim from
// Russian, compiles perfectly and only shows up in front of a seller.

import { OilType, PackageForm } from '@prisma/client';
import { APP_LANGS, type AppLang } from '../../common/app-lang.util';
import {
  BOT_STRINGS,
  LANGUAGE_BUTTON_LABELS,
  LANG_ACTION,
  langAction,
  languageKeyboard,
  oilTypeLabel,
  packageFormLabel,
  t,
  type BotStringKey,
} from './index';

const KEYS = Object.keys(BOT_STRINGS.ru) as BotStringKey[];

/** The `{placeholder}` names a template uses, sorted. */
const slotsOf = (template: string) =>
  [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionary parity', () => {
  it('ships all three languages', () => {
    expect(Object.keys(BOT_STRINGS).sort()).toEqual(['en', 'ru', 'uz']);
  });

  it.each(APP_LANGS)('%s defines every key with a non-empty string', (lang) => {
    for (const key of KEYS) {
      const value = BOT_STRINGS[lang][key];
      expect(typeof value).toBe('string');
      expect(value.trim()).not.toBe('');
    }
  });

  it.each(APP_LANGS)(
    '%s uses exactly the placeholders Russian does',
    (lang) => {
      for (const key of KEYS) {
        expect({ key, slots: slotsOf(BOT_STRINGS[lang][key]) }).toEqual({
          key,
          slots: slotsOf(BOT_STRINGS.ru[key]),
        });
      }
    },
  );

  it('has no Cyrillic left in the English or Uzbek copy', () => {
    // Uzbek ships in LATIN script and English in Latin, so any Cyrillic
    // character in either dictionary is an untranslated Russian string. The
    // trilingual language prompt is the one deliberate exception: it must be
    // readable to a seller who has not chosen a language yet.
    const cyrillic = /[А-Яа-яЁё]/;
    for (const lang of ['uz', 'en'] as AppLang[]) {
      for (const key of KEYS) {
        if (key === 'lang.prompt') continue;
        expect({
          lang,
          key,
          cyrillic: cyrillic.test(BOT_STRINGS[lang][key]),
        }).toEqual({ lang, key, cyrillic: false });
      }
    }
  });
});

describe('t()', () => {
  it('returns the string for the requested language', () => {
    expect(t('ru', 'btn.skip')).toBe('⏭ Пропустить');
    expect(t('uz', 'btn.skip')).toBe('⏭ O‘tkazib yuborish');
    expect(t('en', 'btn.skip')).toBe('⏭ Skip');
  });

  it('fills placeholders from params', () => {
    expect(t('en', 'photos.received', { count: 3 })).toContain('(3)');
    expect(t('ru', 'step.model', { brand: 'Chevrolet' })).toContain(
      'Chevrolet',
    );
  });

  it('leaves an unsupplied placeholder in place rather than printing undefined', () => {
    expect(t('en', 'step.model')).toContain('{brand}');
    expect(t('en', 'step.model', {})).toContain('{brand}');
  });

  it('falls back to Russian for an unknown language instead of throwing', () => {
    expect(t('de' as AppLang, 'btn.back')).toBe(t('ru', 'btn.back'));
  });
});

describe('enum labels', () => {
  it.each(APP_LANGS)('renders both sale forms in %s', (lang) => {
    const single = packageFormLabel(PackageForm.SINGLE, lang);
    const set = packageFormLabel(PackageForm.SET, lang);
    expect(single).toBe(t(lang, 'packageForm.single'));
    expect(set).toBe(t(lang, 'packageForm.set'));
    expect(single).not.toBe(set);
  });

  it.each(Object.values(OilType))(
    'renders oil type %s in every language',
    (type) => {
      const labels = APP_LANGS.map((lang) => oilTypeLabel(type, lang));
      expect(labels.every((l) => l.trim().length > 0)).toBe(true);
    },
  );

  it('keeps the Russian oil labels identical to the shared catalog copy', () => {
    // The buyer catalog renders these from common/motor-oil.util; the bot must
    // not drift from it.
    expect(oilTypeLabel(OilType.SYNTHETIC, 'ru')).toBe('Синтетическое');
    expect(oilTypeLabel(OilType.SEMI_SYNTHETIC, 'ru')).toBe(
      'Полусинтетическое',
    );
    expect(oilTypeLabel(OilType.MINERAL, 'ru')).toBe('Минеральное');
  });
});

describe('language menu', () => {
  it('asks the question in all three languages at once', () => {
    // The seller has not chosen yet, so this one screen cannot assume a
    // language — the same trilingual header is used whatever the fallback is.
    for (const lang of APP_LANGS) {
      const prompt = t(lang, 'lang.prompt');
      expect(prompt).toContain('Выберите язык');
      expect(prompt).toContain('Tilingizni tanlang');
      expect(prompt).toContain('Choose your language');
    }
  });

  it('labels each button in its OWN language, not the current one', () => {
    expect(LANGUAGE_BUTTON_LABELS).toEqual({
      ru: 'Русский 🇷🇺',
      uz: 'O‘zbekcha 🇺🇿',
      en: 'English 🇬🇧',
    });
  });

  it.each(APP_LANGS)(
    'builds a payload for %s that the action matches',
    (lang) => {
      const payload = langAction(lang);
      expect(payload).toBe(`lang:${lang}`);
      expect(LANG_ACTION.exec(payload)?.[1]).toBe(lang);
    },
  );

  it('does not match a foreign or malformed payload', () => {
    expect(LANG_ACTION.test('lang:de')).toBe(false);
    expect(LANG_ACTION.test('lang:')).toBe(false);
    expect(LANG_ACTION.test('wiz:5:c:brakes')).toBe(false);
  });

  it('renders one full-width button per language, in menu order', () => {
    const rows = languageKeyboard().reply_markup.inline_keyboard;
    expect(rows.map((r) => r.length)).toEqual([1, 1, 1]);
    expect(
      rows.map((r) => (r[0] as { callback_data: string }).callback_data),
    ).toEqual(['lang:ru', 'lang:uz', 'lang:en']);
  });
});
