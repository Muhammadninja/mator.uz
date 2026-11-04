import { CANONICAL_RESPONSES, detectLanguage, detectConversationLanguage, makesUnsupportedPromise } from './i18n.util';

describe('detectLanguage', () => {
  it('detects Russian Cyrillic', () => {
    expect(detectLanguage('Нужны тормозные колодки на Malibu')).toBe('ru');
    expect(detectLanguage('Здравствуйте, есть масло?')).toBe('ru');
  });

  it('detects Uzbek-Cyrillic by its distinctive letters', () => {
    expect(detectLanguage('Malibuга колодка керак, йўқми?')).toBe('uz_cyr');
    expect(detectLanguage('Менга ёғ фильтри керак')).toBe('uz_cyr');
  });

  it('detects Uzbek-Latin by apostrophe forms or common words', () => {
    expect(detectLanguage('Malibuga old kolodka kerak')).toBe('uz_lat');
    expect(detectLanguage("moshinaga ehtiyot qism kerak")).toBe('uz_lat');
    expect(detectLanguage("yo‘q, menga boshqa narx")).toBe('uz_lat');
  });

  it('falls back to ru for English / bare translit', () => {
    expect(detectLanguage('I need brake pads for Malibu')).toBe('ru');
    expect(detectLanguage('')).toBe('ru');
    expect(detectLanguage(null)).toBe('ru');
  });
});

describe('CANONICAL_RESPONSES', () => {
  it('has non-empty copy for every intent × language', () => {
    for (const intent of Object.keys(CANONICAL_RESPONSES) as (keyof typeof CANONICAL_RESPONSES)[]) {
      for (const lang of ['ru', 'uz_lat', 'uz_cyr'] as const) {
        expect(CANONICAL_RESPONSES[intent][lang].length).toBeGreaterThan(10);
      }
    }
  });

  it('confirms a request across languages, with no response-time promise', () => {
    expect(CANONICAL_RESPONSES.CREATE_SOURCING_TICKET.ru).toContain('Заявка принята');
    expect(CANONICAL_RESPONSES.CREATE_SOURCING_TICKET.uz_lat).toContain('qabul qilindi');
    expect(CANONICAL_RESPONSES.CREATE_SOURCING_TICKET.uz_cyr).toContain('қабул қилинди');
    for (const copy of Object.values(CANONICAL_RESPONSES)) {
      for (const text of Object.values(copy)) expect(makesUnsupportedPromise(text)).toBe(false);
    }
  });
});

describe('makesUnsupportedPromise', () => {
  it.each([
    'Наш отдел закупок проверяет цены и свяжется с вами в течение 15 минут.',
    'Ответим через 2 часа',
    'Ta’minot bo‘limimiz 15 daqiqa ichida bog‘lanadi',
    'Our sourcing department will respond within 15 minutes.',
  ])('catches %s', (text) => expect(makesUnsupportedPromise(text)).toBe(true));

  it.each(['Какая запчасть вам нужна?', 'Масло 5W-30, объём 4 литра', 'Передний или задний?'])(
    'allows %s',
    (text) => expect(makesUnsupportedPromise(text)).toBe(false),
  );
});

describe('detectConversationLanguage', () => {
  it('keeps the language when a short reply shows none', () => {
    expect(detectConversationLanguage('Salon', ['Moy filter kerak'])).toBe('uz_lat');
  });
  it('follows the latest message that shows one', () => {
    expect(detectConversationLanguage('Нужен фильтр', ['Moy filter kerak'])).toBe('ru');
  });
  it('defaults to Russian', () => {
    expect(detectConversationLanguage('Salon')).toBe('ru');
  });
});
