/**
 * Lightweight language detection + localized canonical replies for the AI chat.
 *
 * Placed flat in `src/common` to match the existing `*.util.ts` convention
 * (pagination.util, pii.util, motor-oil.util, …) rather than a `utils/` subdir.
 *
 * Supported: Russian (`ru`), Uzbek-Latin (`uz_lat`), Uzbek-Cyrillic (`uz_cyr`).
 * Anything else (incl. English / bare translit) falls back to `ru`, the
 * platform lingua franca.
 */

export type SupportedLang = 'ru' | 'uz_lat' | 'uz_cyr';

/** Intents whose reply is fixed, localized copy (not the LLM's free text). */
export type CanonicalIntent = 'CREATE_SOURCING_TICKET' | 'FOUND_IN_STOCK';

export const CANONICAL_RESPONSES: Record<
  CanonicalIntent,
  Record<SupportedLang, string>
> = {
  CREATE_SOURCING_TICKET: {
    ru: 'Спасибо за обращение! Этой позиции сейчас нет в нашем каталоге. Наш отдел закупок уже проверяет цены и свяжется с вами в течение 15 минут.',
    uz_lat:
      'Murojaatingiz uchun rahmat! Bu mahsulot hozircha katalogimizda yo‘q. Ta’minot bo‘limimiz narxlarni tekshirmoqda va 15 daqiqa ichida siz bilan bog‘lanadi.',
    uz_cyr:
      'Мурожаатингиз учун раҳмат! Бу маҳсулот ҳозирча каталогимизда йўқ. Таъминот бўлимимиз нархларни текширмоқда ва 15 дақиқа ичида сиз билан боғланади.',
  },
  FOUND_IN_STOCK: {
    ru: 'Нашёл подходящие товары в наличии — можете выбрать из списка ниже.',
    uz_lat:
      'Mos keladigan mahsulotlarni topdim — quyidagi ro‘yxatdan tanlashingiz mumkin.',
    uz_cyr:
      'Мос келадиган маҳсулотларни топдим — қуйидаги рўйхатдан танлашингиз мумкин.',
  },
};

// Uzbek-Cyrillic distinctive letters (absent from Russian).
const UZ_CYR_CHARS = /[ўқғҳ]/i;
// Any Cyrillic at all (Russian or Uzbek-Cyrillic).
const CYRILLIC = /[Ѐ-ӿ]/;
// Uzbek-Latin markers: the oʻ / gʻ apostrophe forms, or common function words.
const UZ_LAT_APOS = /o['ʻʼ‘`]|g['ʻʼ‘`]/i;
const UZ_LAT_WORDS =
  /\b(kerak|bor|uchun|menga|senga|mashina|ehtiyot|qism|narx|qancha|nechta|nechi|salom|rahmat|yoq|oldingi|orqa|avto|moy)\b/i;

/**
 * Best-effort language of a short chat message. Cyrillic → `uz_cyr` when it
 * carries Uzbek-only letters, else `ru`. Latin → `uz_lat` when it shows the
 * ʻ-apostrophe forms or a common Uzbek word, else `ru`.
 */
export function detectLanguage(text: string | null | undefined): SupportedLang {
  const t = text ?? '';
  if (CYRILLIC.test(t)) {
    return UZ_CYR_CHARS.test(t) ? 'uz_cyr' : 'ru';
  }
  if (UZ_LAT_APOS.test(t) || UZ_LAT_WORDS.test(t)) return 'uz_lat';
  return 'ru';
}
