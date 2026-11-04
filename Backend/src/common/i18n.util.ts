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
export type CanonicalIntent =
  | 'CREATE_SOURCING_TICKET'
  | 'FOUND_IN_STOCK'
  | 'SOURCING_AUTH_REQUIRED'
  | 'SOURCING_UNAVAILABLE'
  | 'ASK_PART';

export const CANONICAL_RESPONSES: Record<
  CanonicalIntent,
  Record<SupportedLang, string>
> = {
  CREATE_SOURCING_TICKET: {
    ru: 'Заявка принята. Мы сообщим, когда появится предложение.',
    uz_lat: 'Soʻrov qabul qilindi. Taklif paydo boʻlganda xabar beramiz.',
    uz_cyr: 'Сўров қабул қилинди. Таклиф пайдо бўлганда хабар берамиз.',
  },
  FOUND_IN_STOCK: {
    // Says only that they're in stock: whether they fit is per item.
    ru: 'Нашёл товары в наличии — можете выбрать из списка ниже.',
    uz_lat: 'Mavjud mahsulotlarni topdim — quyidagi roʻyxatdan tanlashingiz mumkin.',
    uz_cyr: 'Мавжуд маҳсулотларни топдим — қуйидаги рўйхатдан танлашингиз мумкин.',
  },
  SOURCING_AUTH_REQUIRED: {
    ru: 'Войдите в приложение по номеру телефона, чтобы отправить заявку на эту запчасть.',
    uz_lat: 'Bu ehtiyot qismga soʻrov yuborish uchun telefon raqamingiz bilan kiring.',
    uz_cyr: 'Бу эҳтиёт қисмга сўров юбориш учун телефон рақамингиз билан киринг.',
  },
  SOURCING_UNAVAILABLE: {
    ru: 'Этой запчасти нет в каталоге, и сейчас мы не можем принять заявку на неё.',
    uz_lat: 'Bu ehtiyot qism katalogda yoʻq va hozir unga soʻrov qabul qila olmaymiz.',
    uz_cyr: 'Бу эҳтиёт қисм каталогда йўқ ва ҳозир унга сўров қабул қила олмаймиз.',
  },
  ASK_PART: {
    ru: 'Какая запчасть вам нужна?',
    uz_lat: 'Sizga qaysi ehtiyot qism kerak?',
    uz_cyr: 'Сизга қайси эҳтиёт қисм керак?',
  },
};

/**
 * True when text promises a response time or says a request is being worked on.
 * The model is told not to; this catches it anyway, because such a reply reaches
 * the customer with no ticket behind it.
 */
export function makesUnsupportedPromise(text: string): boolean {
  return (
    /\b\d+\s*(минут|мин\b|час|дақиқа|соат|daqiqa|soat|min\b|minute|hour)/iu.test(text) ||
    /в\s+течение\s+(часа|дня|минут)|отдел\s+закупок|ta.minot\s+bo.limi|таъминот\s+бўлими|sourcing\s+department/iu.test(
      text,
    )
  );
}

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

/**
 * Language of a conversation: the latest message that shows one. A short reply
 * like "Salon" says nothing, so it shouldn't switch an Uzbek chat to Russian.
 */
export function detectConversationLanguage(
  message: string,
  earlierUserMessages: readonly string[] = [],
): SupportedLang {
  for (const text of [message, ...[...earlierUserMessages].reverse()]) {
    if (CYRILLIC.test(text) || UZ_LAT_APOS.test(text) || UZ_LAT_WORDS.test(text)) {
      return detectLanguage(text);
    }
  }
  return 'ru';
}
