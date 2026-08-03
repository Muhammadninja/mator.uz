import { CANONICAL_RESPONSES, detectLanguage } from './i18n.util';

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
    for (const intent of ['CREATE_SOURCING_TICKET', 'FOUND_IN_STOCK'] as const) {
      for (const lang of ['ru', 'uz_lat', 'uz_cyr'] as const) {
        expect(CANONICAL_RESPONSES[intent][lang].length).toBeGreaterThan(10);
      }
    }
  });

  it('keeps the 15-minute SLA promise across languages', () => {
    expect(CANONICAL_RESPONSES.CREATE_SOURCING_TICKET.ru).toContain('15 минут');
    expect(CANONICAL_RESPONSES.CREATE_SOURCING_TICKET.uz_lat).toContain('15 daqiqa');
    expect(CANONICAL_RESPONSES.CREATE_SOURCING_TICKET.uz_cyr).toContain('15 дақиқа');
  });
});
