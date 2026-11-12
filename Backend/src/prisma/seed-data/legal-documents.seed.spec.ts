import { LegalDocumentType } from '@prisma/client';
import {
  LEGAL_LOCALES,
  isPlaceholderLegalContent,
  legalDocumentSeed,
} from './legal-documents.seed';

/**
 * Guards on the REAL `docs/legal` source set — the files that actually seed the
 * database. Complements legal-documents.loader.spec.ts, which exercises parsing
 * and validation against synthetic fixtures.
 */
describe('legal document seed', () => {
  const seed = legalDocumentSeed();

  it('covers every required document type', () => {
    const types = new Set(seed.map((d) => d.type));
    expect(types).toEqual(new Set(Object.keys(LegalDocumentType)));
  });

  it('ships every interface language for every document', () => {
    for (const type of Object.keys(LegalDocumentType) as LegalDocumentType[]) {
      const locales = seed.filter((d) => d.type === type).map((d) => d.locale);
      expect(new Set(locales)).toEqual(new Set(LEGAL_LOCALES));
    }
  });

  it('covers exactly the languages the app offers', () => {
    expect(new Set(seed.map((d) => d.locale))).toEqual(new Set(LEGAL_LOCALES));
  });

  it('ships exactly the expected versions per document', () => {
    const versions = (type: LegalDocumentType) =>
      [...new Set(seed.filter((d) => d.type === type).map((d) => d.version))].sort();
    expect(versions(LegalDocumentType.TERMS_OF_USE)).toEqual([1, 2]);
    expect(versions(LegalDocumentType.PRIVACY_POLICY)).toEqual([1]);
    expect(versions(LegalDocumentType.PERSONAL_DATA_CONSENT)).toEqual([1]);
    expect(versions(LegalDocumentType.REFUND_POLICY)).toEqual([1]);
  });

  it('has a unique (type, version, locale) per row — the DB unique key', () => {
    const keys = seed.map((d) => `${d.type}|${d.version}|${d.locale}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every row a real title', () => {
    for (const doc of seed) {
      expect(doc.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('gives every row a non-empty body', () => {
    for (const doc of seed) {
      expect(doc.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('writes each title in its OWN language', () => {
    const byKey = (type: LegalDocumentType, locale: string) =>
      seed.find((d) => d.type === type && d.locale === locale)!.title;

    // Cyrillic for ru, Latin for uz/en — a copy-paste slip that leaves the
    // Russian title on the English document is caught here.
    expect(byKey(LegalDocumentType.PRIVACY_POLICY, 'ru')).toMatch(/[А-Яа-я]/);
    expect(byKey(LegalDocumentType.PRIVACY_POLICY, 'en')).not.toMatch(/[А-Яа-я]/);
    expect(byKey(LegalDocumentType.PRIVACY_POLICY, 'uz')).not.toMatch(/[А-Яа-я]/);
  });

  it('detects approved text as NOT placeholder — the seed must never overwrite it', () => {
    expect(
      isPlaceholderLegalContent('# Политика\n\nНастоящая Политика определяет…'),
    ).toBe(false);
  });

  it('treats BLANK content as overwritable, not as approved text', () => {
    expect(isPlaceholderLegalContent('')).toBe(true);
    expect(isPlaceholderLegalContent('   \n  ')).toBe(true);
    expect(isPlaceholderLegalContent(null)).toBe(true);
    expect(isPlaceholderLegalContent(undefined)).toBe(true);
  });

  it('flags the untranslated locales as placeholders', () => {
    // uz/en are not translated yet. This test is expected to CHANGE when they
    // are: it documents the current state rather than freezing it.
    for (const doc of seed.filter((d) => d.locale !== 'ru')) {
      expect(isPlaceholderLegalContent(doc.content)).toBe(true);
    }
  });

  it('takes every effective date from the text — v1 is 01.09.2026, as its text says', () => {
    for (const doc of seed.filter((d) => d.version === 1 && d.type !== LegalDocumentType.REFUND_POLICY)) {
      expect(doc.effectiveAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    }
  });

  it('leaves the documents whose date is still blank unpublished', () => {
    // Expected to CHANGE when the owner fills in the dates: it documents the
    // current state (Terms v2 and the Refund & Returns Policy are drafts).
    const drafts = seed.filter((d) => d.effectiveAt === null).map((d) => `${d.type} v${d.version}`);
    expect(new Set(drafts)).toEqual(new Set(['TERMS_OF_USE v2', 'REFUND_POLICY v1']));
  });
});
