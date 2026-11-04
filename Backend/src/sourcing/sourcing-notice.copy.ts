import { Language, SourcingTicketStatus } from '@prisma/client';

export type SourcingNotice = 'IN_PROGRESS' | 'CLOSED' | 'CANCELLED' | 'NO_OFFER' | 'OFFERS_EXPIRED';

const COPY: Record<SourcingNotice, Record<Language, { title: string; body: string }>> = {
  IN_PROGRESS: {
    RU: { title: 'Заявка в работе', body: 'Ищем: {part}.' },
    UZ: { title: 'Soʻrov koʻrib chiqilmoqda', body: 'Qidirilmoqda: {part}.' },
    EN: { title: 'Request in progress', body: 'We’re looking for: {part}.' },
  },
  CLOSED: {
    RU: { title: 'Заявка закрыта', body: 'Заявка закрыта: {part}.' },
    UZ: { title: 'Soʻrov yopildi', body: 'Soʻrov yopildi: {part}.' },
    EN: { title: 'Request closed', body: 'Request closed: {part}.' },
  },
  CANCELLED: {
    RU: { title: 'Заявка отменена', body: 'Заявка отменена: {part}.' },
    UZ: { title: 'Soʻrov bekor qilindi', body: 'Soʻrov bekor qilindi: {part}.' },
    EN: { title: 'Request cancelled', body: 'Request cancelled: {part}.' },
  },
  NO_OFFER: {
    RU: { title: 'Предложений нет', body: 'Не нашли предложений: {part}.' },
    UZ: { title: 'Takliflar yoʻq', body: 'Takliflar topilmadi: {part}.' },
    EN: { title: 'No offers', body: 'We found no offers for: {part}.' },
  },
  OFFERS_EXPIRED: {
    RU: { title: 'Предложение истекло', body: 'Срок предложения истёк: {part}.' },
    UZ: { title: 'Taklif muddati tugadi', body: 'Taklif muddati tugadi: {part}.' },
    EN: { title: 'Offer expired', body: 'The offer has expired: {part}.' },
  },
};

export function sourcingNoticeCopy(notice: SourcingNotice, language: Language, part: string) {
  const { title, body } = COPY[notice][language];
  return { title, body: body.replace('{part}', part) };
}

/** Staff status changes the customer should hear about. */
export function noticeForStatus(status: SourcingTicketStatus): SourcingNotice | null {
  switch (status) {
    case SourcingTicketStatus.IN_PROGRESS:
    case SourcingTicketStatus.CLOSED:
    case SourcingTicketStatus.CANCELLED:
    case SourcingTicketStatus.NO_OFFER:
      return status;
    default:
      return null;
  }
}
