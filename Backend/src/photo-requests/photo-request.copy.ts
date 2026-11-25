import { Language } from '@prisma/client';

import type { SupportedLang } from '../common/i18n.util';

/** What the chat says back to a photo request. */
export type PhotoReply = 'REQUESTED' | 'AUTH_REQUIRED' | 'ALREADY_AVAILABLE' | 'NOT_FOUND';

const REPLIES: Record<PhotoReply, Record<SupportedLang, string>> = {
  REQUESTED: {
    ru: 'Запрос на фото принят. Пришлём уведомление, когда фото появится.',
    uz_lat: 'Surat soʻrovi qabul qilindi. Surat paydo boʻlganda xabar yuboramiz.',
    uz_cyr: 'Сурат сўрови қабул қилинди. Сурат пайдо бўлганда хабар юборамиз.',
  },
  AUTH_REQUIRED: {
    ru: 'Войдите по номеру телефона, чтобы запросить фото. Так мы сможем сообщить, когда оно появится.',
    uz_lat: 'Surat soʻrash uchun telefon raqamingiz bilan kiring. Shunda surat paydo boʻlganda xabar bera olamiz.',
    uz_cyr: 'Сурат сўраш учун телефон рақамингиз билан киринг. Шунда сурат пайдо бўлганда хабар бера оламиз.',
  },
  ALREADY_AVAILABLE: {
    ru: 'У этого товара уже есть фото — откройте его карточку.',
    uz_lat: 'Bu mahsulotning surati allaqachon bor — kartasini oching.',
    uz_cyr: 'Бу маҳсулотнинг сурати аллақачон бор — картасини очинг.',
  },
  NOT_FOUND: {
    ru: 'Не нашли этот товар в каталоге. Напишите, какая запчасть вам нужна.',
    uz_lat: 'Bu mahsulot katalogda topilmadi. Sizga qaysi ehtiyot qism kerakligini yozing.',
    uz_cyr: 'Бу маҳсулот каталогда топилмади. Сизга қайси эҳтиёт қисм кераклигини ёзинг.',
  },
};

export function photoReplyText(reply: PhotoReply, lang: SupportedLang): string {
  return REPLIES[reply][lang];
}

const ADDED: Record<Language, { title: string; body: string }> = {
  RU: { title: 'Фото добавлено', body: 'Появилось фото товара: {part}.' },
  UZ: { title: 'Surat qoʻshildi', body: 'Mahsulot surati paydo boʻldi: {part}.' },
  EN: { title: 'Photo added', body: 'A photo is now available for: {part}.' },
};

/** The notification a customer gets once the part they asked about has a photo. */
export function photoAddedCopy(language: Language, part: string) {
  const { title, body } = ADDED[language];
  return { title, body: body.replace('{part}', part) };
}
