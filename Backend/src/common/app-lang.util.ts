/**
 * The three INTERFACE languages Mator ships — Russian, Uzbek (Latin script) and
 * English — plus the conversions between their wire form and the `BotLanguage`
 * enum stored on a seller, and the rule for picking a category's display name.
 *
 * Deliberately separate from {@link ./i18n.util}: that module DETECTS the
 * language of a free-text chat message and distinguishes Uzbek's two scripts,
 * because it has to read what a buyer typed. This one is about a language a
 * user EXPLICITLY CHOSE from a menu — a closed set of three, with no detection
 * and no script variants. Merging them would force each side to carry the
 * other's cases (`uz_cyr` has no button; `en` is not a chat-detection outcome).
 *
 * Placed flat in `src/common` per the existing `*.util.ts` convention.
 */
import { BotLanguage } from '@prisma/client';

/** Interface language code as it appears on the wire and in the bot. */
export type AppLang = 'ru' | 'uz' | 'en';

/** Every supported language, in the order the language menu renders them. */
export const APP_LANGS: readonly AppLang[] = ['ru', 'uz', 'en'] as const;

/**
 * The language used when a user has not chosen one (and for any legacy row):
 * Russian, the platform lingua franca and the language every existing bot
 * message was written in.
 */
export const DEFAULT_APP_LANG: AppLang = 'ru';

const TO_ENUM: Record<AppLang, BotLanguage> = {
  ru: BotLanguage.RU,
  uz: BotLanguage.UZ,
  en: BotLanguage.EN,
};

const FROM_ENUM: Record<BotLanguage, AppLang> = {
  [BotLanguage.RU]: 'ru',
  [BotLanguage.UZ]: 'uz',
  [BotLanguage.EN]: 'en',
};

/** `'uz'` → `BotLanguage.UZ`. */
export function toBotLanguage(lang: AppLang): BotLanguage {
  return TO_ENUM[lang];
}

/**
 * `BotLanguage.UZ` → `'uz'`. `null`/`undefined` (a seller who never picked a
 * language) yields the default, so callers never branch on "unset".
 */
export function toAppLang(lang: BotLanguage | null | undefined): AppLang {
  return lang ? FROM_ENUM[lang] : DEFAULT_APP_LANG;
}

/**
 * Parse a client-supplied language code. Case-insensitive; anything outside the
 * supported set (including Uzbek Cyrillic, which has no button) returns null so
 * the caller can reject it rather than silently serving the wrong language.
 */
export function parseAppLang(raw: string | null | undefined): AppLang | null {
  const value = raw?.trim().toLowerCase();
  return APP_LANGS.includes(value as AppLang) ? (value as AppLang) : null;
}

/**
 * Widen a BCP-47 tag to its primary subtag: `ru-RU` → `ru`, `uz-Latn-UZ` →
 * `uz`. Region and script are dropped because Mator ships ONE variant per
 * language (Uzbek is Latin-only here), so `uz-Cyrl` cannot be honoured as
 * anything but `uz` — and answering `uz` beats answering the default.
 */
function primarySubtag(tag: string): string {
  return tag.split('-', 1)[0];
}

/**
 * The best supported language for an `Accept-Language` header value.
 *
 * Implements the parts of RFC 9110 §12.5.4 that can actually change the answer
 * for a three-language set: comma-separated tags, `;q=` weights, the `*`
 * wildcard, and region/script subtags. Ordering is by DESCENDING q, and ties
 * keep the order the client listed them in — a stable sort, so `ru,uz` prefers
 * Russian while `uz,ru` prefers Uzbek, both at the implied q=1.
 *
 * A `q=0` tag means "explicitly not this one" and is dropped rather than
 * ranked last, which is the one place a naive sort silently serves a language
 * the client just refused.
 *
 * @returns the matched language, or null when the header is absent, malformed,
 *   or names only unsupported languages — the caller applies the default. It
 *   never throws and never returns an unsupported code, so a hostile header
 *   costs a fallback, not a 500.
 */
export function parseAcceptLanguage(
  header: string | null | undefined,
): AppLang | null {
  if (typeof header !== 'string' || !header.trim()) return null;

  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      // Only `q` is meaningful here; any other parameter is ignored, as is a
      // malformed weight (NaN), which RFC-wise defaults back to 1.
      const q = params
        .map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p))
        .find((m) => m !== null)?.[1];
      const weight = q === undefined ? 1 : Number.parseFloat(q);
      return {
        tag: tag.trim().toLowerCase(),
        // An unparseable q is treated as the default 1, not as 0 — a typo in a
        // weight should not silently delete the client's preferred language.
        weight: Number.isFinite(weight) ? weight : 1,
        index,
      };
    })
    .filter((e) => e.tag !== '' && e.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  for (const { tag } of ranked) {
    // `*` means "anything you have" — answer with the platform default rather
    // than the first language that happens to sort first.
    if (tag === '*') return DEFAULT_APP_LANG;
    const match = parseAppLang(primarySubtag(tag));
    if (match) return match;
  }
  return null;
}

/**
 * The language to serve a request in: the client's `Accept-Language` when it
 * names one Mator ships, else {@link DEFAULT_APP_LANG}.
 *
 * The total function every buyer-facing caller should use — it cannot return
 * null, so no endpoint has to invent its own fallback and no category label can
 * come back blank for a missing or unsupported header.
 */
export function resolveRequestLang(
  header: string | null | undefined,
): AppLang {
  return parseAcceptLanguage(header) ?? DEFAULT_APP_LANG;
}

/** The three localized names every category carries. */
export interface LocalizedNames {
  nameRu: string;
  nameUz: string;
  nameEn: string;
}

/**
 * The display name of a category in `lang`.
 *
 * All three columns are NOT NULL, so in a well-formed row this is a plain
 * lookup. The `||` fallbacks exist for the one case the DB cannot rule out — a
 * row read through a partial `select`, or a value that is present but blank —
 * and they degrade in a fixed order (requested → Russian → Uzbek → English)
 * rather than rendering an empty button.
 */
export function localizedCategoryName(
  category: Partial<LocalizedNames> & { name?: string },
  lang: AppLang,
): string {
  const byLang: Record<AppLang, string | undefined> = {
    ru: category.nameRu,
    uz: category.nameUz,
    en: category.nameEn,
  };
  return (
    byLang[lang]?.trim() ||
    category.nameRu?.trim() ||
    category.nameUz?.trim() ||
    category.nameEn?.trim() ||
    category.name?.trim() ||
    ''
  );
}
