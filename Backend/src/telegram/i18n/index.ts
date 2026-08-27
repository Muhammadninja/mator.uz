/**
 * The seller bot's translation function and the language menu.
 *
 * Deliberately tiny and dependency-free: `t(lang, key, params)` looks the key
 * up in the chosen dictionary and fills `{placeholder}` slots. There is no
 * pluralization engine and no runtime file loading — the three dictionaries are
 * compiled in, so a missing translation is a TYPE error rather than a blank
 * message discovered in production.
 */
import { OilType, PackageForm } from '@prisma/client';
import { Markup } from 'telegraf';
import {
  APP_LANGS,
  DEFAULT_APP_LANG,
  type AppLang,
} from '../../common/app-lang.util';
import { EN } from './en';
import { RU } from './ru';
import { UZ } from './uz';
import type { BotStringKey, BotStrings } from './keys';

export type { BotStringKey, BotStrings } from './keys';

/** Every dictionary, keyed by language. */
export const BOT_STRINGS: Record<AppLang, BotStrings> = {
  ru: RU,
  uz: UZ,
  en: EN,
};

/**
 * The localized string for `key`, with `{name}` placeholders replaced from
 * `params`.
 *
 * An unknown language falls back to Russian (the platform default) rather than
 * throwing: a bot handler must never crash because a stored language could not
 * be resolved — the seller would simply get no reply at all.
 */
export function t(
  lang: AppLang,
  key: BotStringKey,
  params?: Record<string, string | number>,
): string {
  const dictionary = BOT_STRINGS[lang] ?? BOT_STRINGS[DEFAULT_APP_LANG];
  const template = dictionary[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** The seller-facing label of a sale form, localized. */
export function packageFormLabel(form: PackageForm, lang: AppLang): string {
  return form === PackageForm.SET
    ? t(lang, 'packageForm.set')
    : t(lang, 'packageForm.single');
}

/** The seller-facing label of an oil type, localized. */
export function oilTypeLabel(type: OilType, lang: AppLang): string {
  const key = `oilType.${type}` as BotStringKey;
  return t(lang, key);
}

// ── Language menu ───────────────────────────────────────────────────────────
/**
 * Callback payload of a language button. NOT versioned like the wizard's
 * `wiz:*` payloads: the language menu has no catalog behind it, so a button
 * from an old message still means exactly what it meant when it was sent, and
 * honouring it is the correct behaviour.
 */
export const LANG_ACTION = /^lang:(ru|uz|en)$/;

/** Build the callback payload for one language. */
export function langAction(lang: AppLang): string {
  return `lang:${lang}`;
}

/**
 * Button labels. NOT translated — each is written in its OWN language, because
 * a seller who cannot read the current interface language must still recognize
 * their own. That is the entire point of this screen.
 */
export const LANGUAGE_BUTTON_LABELS: Record<AppLang, string> = {
  ru: 'Русский 🇷🇺',
  uz: 'O‘zbekcha 🇺🇿',
  en: 'English 🇬🇧',
};

/** The language picker: one full-width button per supported language. */
export function languageKeyboard() {
  return Markup.inlineKeyboard(
    APP_LANGS.map((lang) => [
      Markup.button.callback(LANGUAGE_BUTTON_LABELS[lang], langAction(lang)),
    ]),
  );
}
