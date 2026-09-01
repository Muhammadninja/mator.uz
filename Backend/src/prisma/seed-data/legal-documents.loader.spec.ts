import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LegalDocumentType } from '@prisma/client';
import {
  LEGAL_LOCALES,
  LEGAL_PLACEHOLDER_MARKER,
  LegalSourceError,
  getLegalDocsDirectory,
  isPlaceholderLegalContent,
  loadLegalDocuments,
} from './legal-documents.loader';

/**
 * Loader tests run against DISPOSABLE fixture directories, never against the
 * real `docs/legal`: a test that writes malformed files into the directory the
 * seed reads could publish broken legal text. The real set is asserted
 * separately (legal-documents.seed.spec.ts) and read-only.
 */
describe('legal documents loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-src-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write one fixture file. */
  const write = (filename: string, contents: string) =>
    fs.writeFileSync(path.join(dir, filename), contents, 'utf8');

  /** A well-formed source file. */
  const valid = (
    type: string,
    version: number,
    locale: string,
    title: string,
    body = 'Полный текст документа.',
  ) =>
    `---\ntype: ${type}\nversion: ${version}\nlocale: ${locale}\ntitle: "${title}"\n---\n\n${body}\n`;

  /** Write a complete, valid v1 set — the baseline the seed expects. */
  const writeCompleteSet = () => {
    for (const type of Object.keys(LegalDocumentType)) {
      for (const locale of LEGAL_LOCALES) {
        const slug = type.toLowerCase().replace(/_/g, '-');
        write(
          `${slug}.v1.${locale}.md`,
          valid(type, 1, locale, `${type} ${locale}`),
        );
      }
    }
  };

  /** Load without the completeness rule, for single-file assertions. */
  const loadPartial = () =>
    loadLegalDocuments(dir, { requireCompleteSet: false });

  // ── 1. Valid front matter ────────────────────────────────────────────────
  it('parses valid front matter into typed metadata', () => {
    write(
      'privacy-policy.v1.ru.md',
      valid('PRIVACY_POLICY', 1, 'ru', 'Политика конфиденциальности'),
    );

    expect(loadPartial()).toEqual([
      {
        type: LegalDocumentType.PRIVACY_POLICY,
        version: 1,
        locale: 'ru',
        title: 'Политика конфиденциальности',
        content: 'Полный текст документа.',
      },
    ]);
  });

  // ── 2. Valid markdown body ───────────────────────────────────────────────
  it('keeps the markdown body verbatim and strips only the front matter', () => {
    const body = '# Заголовок\n\n## 1. Раздел\n\n- пункт\n- пункт\n\n**жирный**';
    write('terms-of-use.v1.ru.md', valid('TERMS_OF_USE', 1, 'ru', 'T', body));

    const [doc] = loadPartial();
    expect(doc.content).toBe(body);
    // The delimiter must not survive into the published text.
    expect(doc.content.startsWith('---')).toBe(false);
    expect(doc.content).not.toContain('type: TERMS_OF_USE');
  });

  it('does not mistake a horizontal rule in the body for a front matter fence', () => {
    const body = 'Первый абзац.\n\n---\n\nВторой абзац после разделителя.';
    write('terms-of-use.v1.ru.md', valid('TERMS_OF_USE', 1, 'ru', 'T', body));

    expect(loadPartial()[0].content).toBe(body);
  });

  it('accepts CRLF line endings and a UTF-8 BOM', () => {
    write(
      'terms-of-use.v1.ru.md',
      '﻿---\r\ntype: TERMS_OF_USE\r\nversion: 1\r\nlocale: ru\r\n' +
        'title: "Соглашение"\r\n---\r\n\r\nТекст.\r\n',
    );

    const [doc] = loadPartial();
    expect(doc.title).toBe('Соглашение');
    expect(doc.content).toBe('Текст.');
  });

  it('accepts an unquoted title', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nversion: 1\nlocale: ru\ntitle: Terms of Use\n---\n\nТекст.\n',
    );

    expect(loadPartial()[0].title).toBe('Terms of Use');
  });

  // ── 3. Invalid document type ─────────────────────────────────────────────
  it('rejects an unknown document type', () => {
    write('cookie-banner.v1.ru.md', valid('COOKIE_BANNER', 1, 'ru', 'X'));

    expect(loadPartial).toThrow(LegalSourceError);
    expect(loadPartial).toThrow(/unknown `type` "COOKIE_BANNER"/);
  });

  it('rejects a missing document type', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\nversion: 1\nlocale: ru\ntitle: "T"\n---\n\nТекст.\n',
    );

    expect(loadPartial).toThrow(/missing `type`/);
  });

  // ── 4. Missing / unsupported locale ──────────────────────────────────────
  it('rejects a missing locale', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nversion: 1\ntitle: "T"\n---\n\nТекст.\n',
    );

    expect(loadPartial).toThrow(/missing `locale`/);
  });

  it('rejects a locale the app does not offer', () => {
    write('terms-of-use.v1.fr.md', valid('TERMS_OF_USE', 1, 'fr', 'T'));

    expect(loadPartial).toThrow(/unsupported `locale` "fr"/);
  });

  it('rejects a filename locale that disagrees with the front matter', () => {
    // The dangerous case: correct text filed under the wrong language.
    write('terms-of-use.v1.en.md', valid('TERMS_OF_USE', 1, 'ru', 'T'));

    expect(loadPartial).toThrow(/filename locale "en" does not match/);
  });

  // ── 5. Invalid version ───────────────────────────────────────────────────
  it('rejects a missing version', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nlocale: ru\ntitle: "T"\n---\n\nТекст.\n',
    );

    expect(loadPartial).toThrow(/missing `version`/);
  });

  it('rejects version 0', () => {
    write('terms-of-use.v0.ru.md', valid('TERMS_OF_USE', 0, 'ru', 'T'));

    expect(loadPartial).toThrow(/`version` must be >= 1/);
  });

  it('rejects a non-integer version', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nversion: 1.0\nlocale: ru\ntitle: "T"\n---\n\nТекст.\n',
    );

    expect(loadPartial).toThrow(/must be a positive integer, got "1.0"/);
  });

  it('rejects a filename version that disagrees with the front matter', () => {
    write('terms-of-use.v2.ru.md', valid('TERMS_OF_USE', 1, 'ru', 'T'));

    expect(loadPartial).toThrow(/filename says v2 but front matter says v1/);
  });

  // ── 6. Duplicates ────────────────────────────────────────────────────────
  it('rejects two files claiming the same (type, version, locale)', () => {
    write('terms-of-use.v1.ru.md', valid('TERMS_OF_USE', 1, 'ru', 'A'));
    write('user-agreement.v1.ru.md', valid('TERMS_OF_USE', 1, 'ru', 'B'));

    expect(loadPartial).toThrow(/duplicate document TERMS_OF_USE v1 \(ru\)/);
    // Both filenames are named, so the author can tell which to delete.
    expect(loadPartial).toThrow(/terms-of-use\.v1\.ru\.md/);
    expect(loadPartial).toThrow(/user-agreement\.v1\.ru\.md/);
  });

  // ── 7. Missing content ───────────────────────────────────────────────────
  it('rejects an empty body', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nversion: 1\nlocale: ru\ntitle: "T"\n---\n\n   \n',
    );

    expect(loadPartial).toThrow(/markdown body is empty/);
  });

  // ── 7a. Unresolved draft markers ─────────────────────────────────────────
  // Text that still awaits counsel reads as ordinary prose, so nothing else
  // downstream would catch it — and once stored and accepted it is frozen.
  it('rejects text that still carries a counsel-review marker', () => {
    write(
      'terms-of-use.v1.ru.md',
      valid(
        'TERMS_OF_USE',
        1,
        'ru',
        'T',
        '> **[НА ЮРИДИЧЕСКУЮ ПРОВЕРКУ]** — раздел 9.\n\nТекст.',
      ),
    );

    expect(loadPartial).toThrow(LegalSourceError);
    expect(loadPartial).toThrow(/unresolved draft markers/);
  });

  it('rejects text with unfilled company details', () => {
    write(
      'terms-of-use.v1.ru.md',
      valid('TERMS_OF_USE', 1, 'ru', 'T', 'ИНН: [ИНН]\nE-mail: [EMAIL]'),
    );

    expect(loadPartial).toThrow(/unresolved draft markers/);
    expect(loadPartial).toThrow(/\[EMAIL\]/);
  });

  it('allows draft markers while the file is still marked a placeholder', () => {
    write(
      'terms-of-use.v1.ru.md',
      valid(
        'TERMS_OF_USE',
        1,
        'ru',
        'T',
        `${LEGAL_PLACEHOLDER_MARKER}\n\n[НА ЮРИДИЧЕСКУЮ ПРОВЕРКУ] Текст. E-mail: [EMAIL]`,
      ),
    );

    expect(loadPartial()).toHaveLength(1);
  });

  it('accepts approved text with every marker closed', () => {
    write(
      'terms-of-use.v1.ru.md',
      valid('TERMS_OF_USE', 1, 'ru', 'T', 'ИНН: 300000000\nE-mail: legal@mator.uz'),
    );

    expect(loadPartial()).toHaveLength(1);
  });

  // ── 8. Malformed front matter ────────────────────────────────────────────
  it('rejects a file with no front matter at all', () => {
    write('terms-of-use.v1.ru.md', '# Просто markdown\n\nБез метаданных.\n');

    expect(loadPartial).toThrow(/missing or malformed front matter/);
  });

  it('rejects an unterminated front matter block', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nversion: 1\nlocale: ru\ntitle: "T"\n\nТекст.\n',
    );

    expect(loadPartial).toThrow(/missing or malformed front matter/);
  });

  it('rejects a front matter line that is not `key: value`', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nversion 1\nlocale: ru\ntitle: "T"\n---\n\nТекст.\n',
    );

    expect(loadPartial).toThrow(/is not `key: value`/);
  });

  it('rejects a duplicated front matter key', () => {
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nversion: 1\nlocale: ru\nlocale: en\ntitle: "T"\n---\n\nТекст.\n',
    );

    expect(loadPartial).toThrow(/duplicate front matter key "locale"/);
  });

  it('rejects publication state in the front matter', () => {
    // effectiveAt/isActive belong to the database, not to a source file.
    write(
      'terms-of-use.v1.ru.md',
      '---\ntype: TERMS_OF_USE\nversion: 1\nlocale: ru\ntitle: "T"\n' +
        'is_active: true\n---\n\nТекст.\n',
    );

    expect(loadPartial).toThrow(/unsupported front matter key\(s\): is_active/);
  });

  // ── 9. The complete expected v1 set ──────────────────────────────────────
  it('loads exactly 9 sources for a complete v1 set', () => {
    writeCompleteSet();

    const sources = loadLegalDocuments(dir);
    expect(sources).toHaveLength(
      Object.keys(LegalDocumentType).length * LEGAL_LOCALES.length,
    );
    expect(sources).toHaveLength(9);
  });

  it('fails when a translation is missing from the set', () => {
    writeCompleteSet();
    fs.unlinkSync(path.join(dir, 'privacy-policy.v1.uz.md'));

    expect(() => loadLegalDocuments(dir)).toThrow(/PRIVACY_POLICY v1 \(uz\)/);
  });

  it('fails when a new version is published in only one locale', () => {
    // The scenario that would leave Russian users on v2 and everyone else on v1.
    writeCompleteSet();
    write('privacy-policy.v2.ru.md', valid('PRIVACY_POLICY', 2, 'ru', 'P v2'));

    expect(() => loadLegalDocuments(dir)).toThrow(/PRIVACY_POLICY v2 \(uz\)/);
    expect(() => loadLegalDocuments(dir)).toThrow(/PRIVACY_POLICY v2 \(en\)/);
  });

  it('accepts a complete v2 set alongside the retained v1 files', () => {
    writeCompleteSet();
    for (const locale of LEGAL_LOCALES) {
      write(
        `privacy-policy.v2.${locale}.md`,
        valid('PRIVACY_POLICY', 2, locale, `P v2 ${locale}`),
      );
    }

    const sources = loadLegalDocuments(dir);
    expect(sources).toHaveLength(12);
    // v1 is retained: it is the text existing users accepted.
    expect(
      sources.filter((s) => s.type === 'PRIVACY_POLICY' && s.version === 1),
    ).toHaveLength(3);
    expect(
      sources.filter((s) => s.type === 'PRIVACY_POLICY' && s.version === 2),
    ).toHaveLength(3);
  });

  it('fails on an empty directory rather than seeding nothing', () => {
    expect(() => loadLegalDocuments(dir)).toThrow(/no legal source files found/);
  });

  it('ignores companion markdown that is not a source file', () => {
    writeCompleteSet();
    write('README.md', '# How legal documents work\n');
    write('00-PRE-PUBLICATION-CHECKLIST.md', '# Checklist\n');

    expect(loadLegalDocuments(dir)).toHaveLength(9);
  });

  // ── 10. Title / content mapping ──────────────────────────────────────────
  it('maps each file to its own title and content', () => {
    write(
      'terms-of-use.v1.ru.md',
      valid('TERMS_OF_USE', 1, 'ru', 'Соглашение', 'Текст соглашения.'),
    );
    write(
      'privacy-policy.v1.ru.md',
      valid('PRIVACY_POLICY', 1, 'ru', 'Политика', 'Текст политики.'),
    );

    const sources = loadPartial();
    const terms = sources.find((s) => s.type === 'TERMS_OF_USE')!;
    const privacy = sources.find((s) => s.type === 'PRIVACY_POLICY')!;

    expect(terms.title).toBe('Соглашение');
    expect(terms.content).toBe('Текст соглашения.');
    expect(privacy.title).toBe('Политика');
    expect(privacy.content).toBe('Текст политики.');
    // No cross-contamination between files.
    expect(terms.content).not.toContain('политики');
  });

  it('returns a stable order across calls', () => {
    writeCompleteSet();

    const keys = () =>
      loadLegalDocuments(dir).map((s) => `${s.type}|${s.version}|${s.locale}`);
    expect(keys()).toEqual(keys());
  });

  // ── Directory resolution ─────────────────────────────────────────────────
  describe('getLegalDocsDirectory', () => {
    it('resolves the real docs/legal directory', () => {
      const resolved = getLegalDocsDirectory();
      expect(fs.existsSync(resolved)).toBe(true);
      expect(path.basename(resolved)).toBe('legal');
      expect(path.basename(path.dirname(resolved))).toBe('docs');
    });

    it('does not depend on the current working directory', () => {
      // The failure this guards: a cwd-relative path that resolves correctly
      // under `npm run seed` from the project root and nowhere else.
      const original = process.cwd();
      try {
        process.chdir(os.tmpdir());
        expect(fs.existsSync(getLegalDocsDirectory())).toBe(true);
      } finally {
        process.chdir(original);
      }
    });

    it('finds the real source files through the resolved directory', () => {
      const sources = loadLegalDocuments();
      expect(sources).toHaveLength(9);
    });
  });

  // ── Placeholder detection ────────────────────────────────────────────────
  describe('isPlaceholderLegalContent', () => {
    it('treats the marker as a placeholder', () => {
      expect(
        isPlaceholderLegalContent('# T\n\n[PLACEHOLDER: FINAL LEGAL TEXT REQUIRED]'),
      ).toBe(true);
    });

    it('treats blank content as a placeholder', () => {
      expect(isPlaceholderLegalContent('')).toBe(true);
      expect(isPlaceholderLegalContent('  \n ')).toBe(true);
      expect(isPlaceholderLegalContent(null)).toBe(true);
      expect(isPlaceholderLegalContent(undefined)).toBe(true);
    });

    it('treats real prose as approved text', () => {
      expect(isPlaceholderLegalContent('# Политика\n\nНастоящая Политика…')).toBe(
        false,
      );
    });
  });
});
