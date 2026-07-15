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
  // INVARIANT: the title is the seller's source of truth. The sanitizer detects
  // brand/model FROM it but never rewrites/shortens/strips the title itself.
  it('detects a brand/model in the title but keeps the title verbatim', () => {
    const r = sanitizeMetadata({
      ...base,
      title: 'Фильтр масляный Cobalt оригинал',
    });
    expect(r.title).toBe('Фильтр масляный Cobalt оригинал'); // NOT stripped
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(['Cobalt']);
  });

  it('does not move condition words out of the title', () => {
    const r = sanitizeMetadata({ ...base, title: 'Фильтр масляный новый' });
    expect(r.title).toBe('Фильтр масляный новый'); // "новый" stays in the title
  });

  it('canonicalizes brand/model aliases that ARE present in the listing text', () => {
    // Make/model come from the text: the title names the vehicles, so they are
    // detected and canonicalized (aliases → canonical forms).
    const r = sanitizeMetadata({
      ...base,
      title: 'Генератор шевроле кобальт gentra',
    });
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(expect.arrayContaining(['Cobalt', 'Gentra']));
  });

  it('IGNORES make/model that an upstream layer supplied but the text does NOT name', () => {
    // The AI fallback can hallucinate a vehicle from an OEM number. When the
    // title/description do not name it, the sanitizer must drop it entirely —
    // compatibility is only ever text- or verified-OEM-derived.
    const r = sanitizeMetadata({
      ...base,
      title: 'Генератор',
      brand: 'шевроле',
      models: ['кобальт', 'gentr'],
      gm_number: '96535062',
    });
    expect(r.brand).toBeNull();
    expect(r.models).toEqual([]);
    expect(r.vehicles).toEqual([]);
    // The number itself is still kept — only the inferred vehicle is dropped.
    expect(r.gm_number).toBe('96535062');
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
    expect(sanitizeMetadata({ ...base, title: 'ab' }).title).toBeNull(); // too short/no word
  });

  it('keeps OEM/price tokens in the title (title is not rewritten)', () => {
    const r = sanitizeMetadata({ ...base, title: 'Фильтр 96535062 25000 сум' });
    expect(r.title).toBe('Фильтр 96535062 25000 сум'); // verbatim, nothing stripped
  });

  it('normalizes only whitespace in the title (collapse duplicates, trim)', () => {
    const r = sanitizeMetadata({ ...base, title: '  Фильтр   масляный  Cobalt  ' });
    expect(r.title).toBe('Фильтр масляный Cobalt');
  });

  it('preserves the seller casing (no capitalization of the title)', () => {
    const r = sanitizeMetadata({ ...base, title: 'фильтр масляный' });
    expect(r.title).toBe('фильтр масляный');
  });

  it('is idempotent', () => {
    const once = sanitizeMetadata({
      ...base,
      title: 'Фильтр масляный Cobalt оригинал',
    });
    const twice = sanitizeMetadata(once);
    expect(twice).toEqual(once);
  });

  it('passes the seller description through and leaves the title untouched', () => {
    const r = sanitizeMetadata({
      ...base,
      title: 'Фильтр новый',
      description: 'Оригинал',
    });
    expect(r.title).toBe('Фильтр новый'); // title untouched (condition word stays)
    expect(r.description).toBe('Оригинал');
  });

  it('detects the make/model into fields while keeping them in the title', () => {
    const r = sanitizeMetadata({ ...base, title: 'Магнитола для Nexia 3' });
    expect(r.title).toBe('Магнитола для Nexia 3'); // verbatim — NOT "Магнитола для"
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(['Nexia 3']);
  });
});
