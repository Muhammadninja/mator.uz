/**
 * Localized OTP SMS copy.
 *
 * A plain, frozen TypeScript dictionary rather than a runtime i18n library: the
 * texts below are the exact strings APPROVED BY THE AGGREGATOR (Eskiz). An
 * unapproved body is rejected at send time, so the copy must never be
 * reassembled, re-wrapped or "improved" at runtime — the only variable part is
 * the `{code}` placeholder.
 *
 * Placed flat in `src/sms` next to `eskiz-callback.util.ts`, matching the
 * existing convention (`src/common/i18n.util.ts` does the same for chat copy).
 * That module's `SupportedLang` is a different, chat-specific alphabet
 * (`uz_lat` / `uz_cyr`); {@link resolveSmsLang} accepts those tags too and folds
 * them onto the SMS set, so the two can be used side by side.
 */

/** Languages an OTP body exists in. Order is documentation only. */
export const SMS_LANGS = ['en', 'ru', 'uz'] as const;

export type SmsLang = (typeof SMS_LANGS)[number];

/**
 * Used whenever the caller says nothing, or says something we do not have copy
 * for. Uzbek is the platform default — the majority of Mator's users — so an
 * unknown tag degrades to the language most likely to be understood rather than
 * failing the login.
 */
export const DEFAULT_SMS_LANG: SmsLang = 'uz';

/** The `{code}` placeholder, substituted by {@link renderOtpMessage}. */
const CODE_PLACEHOLDER = '{code}';

/**
 * Approved OTP bodies, one per language.
 *
 * The Russian variant is deliberately Latin transliteration, not Cyrillic: a
 * Cyrillic body switches the SMS to UCS-2, which halves the per-part character
 * budget and doubles the billed parts. Do not "fix" it to Cyrillic without
 * re-approving the template and accepting the cost change.
 */
export const OTP_SMS_TEMPLATES: Readonly<Record<SmsLang, string>> =
  Object.freeze({
    en: `Mator app: verification code for login ${CODE_PLACEHOLDER}. Do not share it with anyone. Valid for 5 minutes.`,
    ru: `Prilojeniye Mator: kod podtverzhdeniya dlya vhoda ${CODE_PLACEHOLDER}. Nikomu ne peredavayte. Srok deystviya 5 minut.`,
    uz: `Mator ilovasi: tasdiqlash kodingiz ${CODE_PLACEHOLDER}. Hech kimga bermang. Amal qilish muddati 5 daqiqa.`,
  });

/** Type guard over the supported set — the single membership test. */
export function isSmsLang(value: unknown): value is SmsLang {
  return (
    typeof value === 'string' &&
    (SMS_LANGS as readonly string[]).includes(value)
  );
}

/**
 * Normalize any client-supplied language tag onto a supported one.
 *
 * Tolerant on purpose — an OTP must go out even when the client sends a locale
 * we have never seen:
 *   `'RU'` / `' ru '` → `ru`   (case + whitespace)
 *   `'ru-RU'` / `'en_US'`      → primary subtag
 *   `'uz-Latn-UZ'` / `'uz_cyr'` → `uz`
 *   `undefined` / `'de'` / `''` → {@link DEFAULT_SMS_LANG}
 */
export function resolveSmsLang(lang?: string | null): SmsLang {
  if (typeof lang !== 'string') return DEFAULT_SMS_LANG;
  // Split on both separators so BCP-47 (`ru-RU`) and the underscore forms used
  // elsewhere in the codebase (`uz_lat`) collapse to their primary subtag.
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0];
  return isSmsLang(primary) ? primary : DEFAULT_SMS_LANG;
}

/**
 * Render the approved OTP body for `lang`, substituting the code.
 *
 * `split`/`join` rather than `String.replace`, because `replace` gives `$` a
 * special meaning INSIDE the replacement — a code is digits today, but a
 * template change must not be able to turn into a silent corruption.
 */
export function renderOtpMessage(code: string, lang?: string | null): string {
  return OTP_SMS_TEMPLATES[resolveSmsLang(lang)]
    .split(CODE_PLACEHOLDER)
    .join(code);
}
