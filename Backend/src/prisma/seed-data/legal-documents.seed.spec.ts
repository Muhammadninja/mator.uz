// Guards the legal seed dataset. It is the ONLY thing standing between a fresh
// environment and users being asked to consent to nothing at all — and the
// placeholder assertions exist so that shipping un-approved legal text as if it
// were final fails loudly here rather than silently in production.

import { LegalDocumentType } from '@prisma/client';
import { APP_LANGS } from '../../common/app-lang.util';
import {
  LEGAL_DOCUMENT_SEED,
  LEGAL_PLACEHOLDER_MARKER,
  LEGAL_V1_EFFECTIVE_AT,
  isPlaceholderLegalContent,
} from './legal-documents.seed';

describe('legal document seed', () => {
  it('covers every required document type', () => {
    const types = new Set(LEGAL_DOCUMENT_SEED.map((d) => d.type));
    expect(types).toEqual(new Set(Object.values(LegalDocumentType)));
  });

  it('ships every interface language for every document', () => {
    // The same three languages the app itself ships (APP_LANGS). A document
    // available in only some of them would silently fall back to another
    // language for those users — legible, but not what they chose.
    for (const type of Object.values(LegalDocumentType)) {
      const locales = LEGAL_DOCUMENT_SEED.filter((d) => d.type === type).map(
        (d) => d.locale,
      );
      expect(locales.sort()).toEqual(['en', 'ru', 'uz']);
    }
  });

  it('covers exactly the languages the app offers', () => {
    expect(new Set(LEGAL_DOCUMENT_SEED.map((d) => d.locale))).toEqual(
      new Set(APP_LANGS),
    );
  });

  it('writes each title and notice in its OWN language', () => {
    const en = LEGAL_DOCUMENT_SEED.filter((d) => d.locale === 'en');
    expect(en).toHaveLength(Object.values(LegalDocumentType).length);
    // An English row must not carry Cyrillic — that would mean the ru text was
    // copied into the en slot, which is exactly the bug this guards.
    expect(en.every((d) => !/[А-Яа-яЁё]/.test(d.title))).toBe(true);
    expect(en.every((d) => d.content.includes('has not yet been approved'))).toBe(true);
  });

  it('is v1 across the board', () => {
    expect(LEGAL_DOCUMENT_SEED.every((d) => d.version === 1)).toBe(true);
  });

  it('has a unique (type, version, locale) per row — the DB unique key', () => {
    const keys = LEGAL_DOCUMENT_SEED.map(
      (d) => `${d.type}|${d.version}|${d.locale}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every row a real title', () => {
    expect(
      LEGAL_DOCUMENT_SEED.every((d) => d.title.trim().length > 3),
    ).toBe(true);
  });

  it('MARKS every body as placeholder text', () => {
    // The backend must never present invented wording as approved legal text.
    // If this fails because real text was supplied, delete this expectation
    // deliberately — do not weaken it by accident.
    expect(
      LEGAL_DOCUMENT_SEED.every((d) => d.content.includes(LEGAL_PLACEHOLDER_MARKER)),
    ).toBe(true);
    expect(LEGAL_DOCUMENT_SEED.every((d) => isPlaceholderLegalContent(d.content))).toBe(
      true,
    );
  });

  it('detects approved text as NOT placeholder — the seed must never overwrite it', () => {
    expect(isPlaceholderLegalContent('# Реальный текст соглашения')).toBe(false);
    expect(isPlaceholderLegalContent('1. The parties agree as follows…')).toBe(false);
    // The word alone is not the marker; only the full sentinel counts.
    expect(isPlaceholderLegalContent('This placeholder clause is binding.')).toBe(
      false,
    );
  });

  it('treats BLANK content as overwritable, not as approved text', () => {
    // An emptied document is not approved wording. Calling it "real" would leave
    // an empty agreement live and un-repairable by the seed.
    for (const blank of ['', '   ', '\n\t ', null, undefined]) {
      expect(isPlaceholderLegalContent(blank as never)).toBe(true);
    }
  });

  it('uses a FIXED effective date, so re-seeding does not shift it', () => {
    expect(LEGAL_V1_EFFECTIVE_AT.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });
});
