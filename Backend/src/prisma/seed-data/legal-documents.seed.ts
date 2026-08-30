import { LegalDocumentType } from '@prisma/client';

/**
 * Initial legal documents — v1 of each required instrument, in `ru` and `uz`.
 *
 * ⚠️ THE CONTENT BELOW IS NOT LEGAL TEXT. ⚠️
 *
 * Every `content` field is an explicitly marked PLACEHOLDER. The backend must
 * not author, paraphrase or "reasonably approximate" a user agreement, a privacy
 * policy, or a personal-data consent: those are binding instruments whose exact
 * wording carries legal consequence under Uzbek law (incl. the Personal Data
 * Law, No. ZRU-547), and shipping invented text that users then formally consent
 * to would be actively harmful — it would produce consent records pointing at
 * wording no lawyer ever approved.
 *
 * This mirrors the stance already taken by MobileConfigService, which serves
 * NULL legal URLs rather than placeholder ones.
 *
 * ── Replacing the placeholders ──
 * Replace the `title` / `content` strings here and re-run `npm run seed`. The
 * seed updates a document IN PLACE only while it is still a placeholder (see
 * seedLegalDocuments), so this is safe and requires NO backend code change.
 *
 * Once real text is published and users have accepted it, that version is
 * FROZEN: further changes are a NEW version (v2), never an edit — an acceptance
 * that points at rewritten text proves nothing.
 */

/** Marker identifying text that is not yet the approved legal wording. */
export const LEGAL_PLACEHOLDER_MARKER = '[PLACEHOLDER: FINAL LEGAL TEXT REQUIRED]';

export interface LegalDocumentSeed {
  type: LegalDocumentType;
  version: number;
  locale: string;
  title: string;
  content: string;
}

/**
 * The date v1 takes effect. Fixed rather than `new Date()` so re-running the
 * seed does not shift the effective date of an already-published document.
 */
export const LEGAL_V1_EFFECTIVE_AT = new Date('2026-08-31T00:00:00.000Z');

/** Titles per document type and locale. Placeholder-free: these are just names. */
const TITLES: Record<LegalDocumentType, Record<string, string>> = {
  [LegalDocumentType.TERMS_OF_USE]: {
    ru: 'Пользовательское соглашение',
    uz: 'Foydalanuvchi shartnomasi',
    en: 'Terms of Use',
  },
  [LegalDocumentType.PRIVACY_POLICY]: {
    ru: 'Политика конфиденциальности',
    uz: 'Maxfiylik siyosati',
    en: 'Privacy Policy',
  },
  [LegalDocumentType.PERSONAL_DATA_CONSENT]: {
    ru: 'Согласие на обработку персональных данных',
    uz: 'Shaxsiy ma’lumotlarni qayta ishlashga rozilik',
    en: 'Consent to Personal Data Processing',
  },
};

/**
 * Locales v1 ships in — the same three interface languages as APP_LANGS
 * (common/app-lang.util). Adding another needs no schema or code change: a
 * title in TITLES, a notice in placeholderContent, and an entry here.
 */
const LOCALES = ['ru', 'uz', 'en'] as const;

/**
 * Placeholder body. Deliberately states, in the document's own language, that
 * this is not the final text — so that if it ever reaches a screen, the reader
 * sees a notice rather than something that looks like an agreement.
 */
function placeholderContent(
  type: LegalDocumentType,
  locale: string,
  title: string,
): string {
  const notice: Record<string, string> = {
    ru:
      'Текст этого документа ещё не утверждён юридическим отделом. ' +
      'Окончательная редакция будет опубликована до запуска сервиса.',
    uz:
      'Ushbu hujjat matni yuridik bo‘lim tomonidan hali tasdiqlanmagan. ' +
      'Yakuniy tahriri xizmat ishga tushirilgunga qadar chop etiladi.',
    en:
      'The text of this document has not yet been approved by the legal team. ' +
      'The final wording will be published before the service launches.',
  };
  return [
    `# ${title}`,
    '',
    LEGAL_PLACEHOLDER_MARKER,
    '',
    notice[locale] ?? notice.ru,
    '',
    `<!-- document: ${type} · version 1 · locale: ${locale} -->`,
  ].join('\n');
}

/** v1 of every required document, in every shipped locale. */
export const LEGAL_DOCUMENT_SEED: LegalDocumentSeed[] = Object.values(
  LegalDocumentType,
).flatMap((type) =>
  LOCALES.map((locale) => {
    const title = TITLES[type][locale];
    return {
      type,
      version: 1,
      locale,
      title,
      content: placeholderContent(type, locale, title),
    };
  }),
);

/**
 * Whether a stored document may be overwritten by the seed — i.e. it does not
 * hold approved legal text.
 *
 * True for the placeholder marker, and ALSO for blank/whitespace-only content:
 * an empty document is not approved wording either, and treating it as such
 * would leave an empty agreement live forever, since the seed would refuse to
 * repair it. Anything else is assumed to be real, lawyer-approved text and is
 * never touched — the asymmetry is deliberate, because wrongly overwriting
 * approved text is far worse than wrongly refusing to.
 */
export function isPlaceholderLegalContent(
  content: string | null | undefined,
): boolean {
  const value = content?.trim();
  if (!value) return true;
  return value.includes(LEGAL_PLACEHOLDER_MARKER);
}
