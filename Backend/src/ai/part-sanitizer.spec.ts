import { sanitizeMetadata } from './part-sanitizer';
import type { ParsedPartMetadata } from './part-parser.types';

const base: ParsedPartMetadata = {
  title: null,
  description: null,
  brand: null,
  models: [],
  gm_number: null,
  price: null,
};

describe('sanitizeMetadata', () => {
  it('moves a brand/model that leaked into the title out of it', () => {
    const r = sanitizeMetadata({
      ...base,
      title: 'Фильтр масляный Cobalt оригинал',
    });
    expect(r.title).toBe('Фильтр масляный');
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(['Cobalt']);
    expect(r.description?.toLowerCase()).toContain('оригинал');
  });

  it('moves condition words from title to description', () => {
    const r = sanitizeMetadata({ ...base, title: 'Фильтр масляный новый' });
    expect(r.title).toBe('Фильтр масляный');
    expect(r.description?.toLowerCase()).toContain('новый');
  });

  it('canonicalizes brand and model aliases', () => {
    const r = sanitizeMetadata({
      ...base,
      title: 'Генератор',
      brand: 'шевроле',
      models: ['кобальт', 'gentr'],
    });
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(expect.arrayContaining(['Cobalt', 'Gentra']));
  });

  it('coerces gm_number to a digit string', () => {
    const r = sanitizeMetadata({ ...base, title: 'Диск', gm_number: 'GM-965 35062' });
    expect(r.gm_number).toBe('96535062');
  });

  it('coerces invalid price to null and keeps positive numbers', () => {
    expect(sanitizeMetadata({ ...base, title: 'Диск', price: 0 }).price).toBeNull();
    expect(sanitizeMetadata({ ...base, title: 'Диск', price: -5 }).price).toBeNull();
    expect(sanitizeMetadata({ ...base, title: 'Диск', price: 25000 }).price).toBe(25000);
  });

  it('rejects an empty/meaningless title', () => {
    expect(sanitizeMetadata({ ...base, title: '...' }).title).toBeNull();
    expect(sanitizeMetadata({ ...base, title: 'Cobalt' }).title).toBeNull(); // only a model
  });

  it('strips OEM/price tokens that leaked into the title', () => {
    const r = sanitizeMetadata({ ...base, title: 'Фильтр 96535062 25000 сум' });
    expect(r.title).toBe('Фильтр');
  });

  it('is idempotent', () => {
    const once = sanitizeMetadata({
      ...base,
      title: 'Фильтр масляный Cobalt оригинал',
    });
    const twice = sanitizeMetadata(once);
    expect(twice).toEqual(once);
  });

  it('dedups repeated description fragments', () => {
    const r = sanitizeMetadata({
      ...base,
      title: 'Фильтр новый',
      description: 'Новый',
    });
    // "Новый" from description + "новый" from title should not duplicate.
    expect(r.description?.toLowerCase().match(/новый/g)?.length).toBe(1);
  });
});
