import { LegalDocumentType } from '@prisma/client';
import { LegalDocumentSeedSource } from './legal-documents.loader';
import { decideLegalSeedAction } from './legal-seed-decision';

/**
 * The overwrite rules, tested without a database. These decide whether approved
 * legal text can be replaced, so a regression here would not corrupt a row — it
 * would silently change a document users have already consented to.
 */
describe('legal seed decision', () => {
  const source = (
    overrides: Partial<LegalDocumentSeedSource> = {},
  ): LegalDocumentSeedSource => ({
    type: LegalDocumentType.PRIVACY_POLICY,
    version: 1,
    locale: 'ru',
    title: 'Политика конфиденциальности',
    content: '# Политика\n\nФинальный утверждённый текст.',
    ...overrides,
  });

  const PLACEHOLDER = '# Политика\n\n[PLACEHOLDER: FINAL LEGAL TEXT REQUIRED]';

  describe('document absent', () => {
    it('creates it, active', () => {
      expect(decideLegalSeedAction(source(), null, null)).toEqual({
        kind: 'create',
        isActive: true,
      });
    });

    it('creates it INACTIVE when a different version is already in force', () => {
      // Re-seeding v1 after v2 was published must not resurrect v1 alongside it:
      // two active versions on one (type, locale) trips the partial unique index
      // and makes "which version is required?" ambiguous.
      expect(decideLegalSeedAction(source(), null, 2)).toEqual({
        kind: 'create',
        isActive: false,
      });
    });
  });

  describe('Case A — DB placeholder, markdown final text', () => {
    it('refreshes in place', () => {
      const action = decideLegalSeedAction(
        source(),
        { title: 'Политика конфиденциальности', content: PLACEHOLDER },
        null,
      );
      expect(action).toEqual({ kind: 'refresh', isActive: true });
    });

    it('refreshes a blank row too', () => {
      expect(
        decideLegalSeedAction(source(), { title: 'X', content: '   ' }, null),
      ).toEqual({ kind: 'refresh', isActive: true });
    });

    it('refreshes without activating when superseded', () => {
      expect(
        decideLegalSeedAction(
          source(),
          { title: 'X', content: PLACEHOLDER },
          2,
        ),
      ).toEqual({ kind: 'refresh', isActive: false });
    });
  });

  describe('Case B — DB final text, markdown identical', () => {
    it('is a no-op', () => {
      const doc = source();
      expect(
        decideLegalSeedAction(
          doc,
          { title: doc.title, content: doc.content },
          null,
        ),
      ).toEqual({ kind: 'preserve' });
    });
  });

  describe('Case C — DB final text, markdown differs', () => {
    it('does NOT overwrite when the body changed', () => {
      const action = decideLegalSeedAction(
        source({ content: '# Политика\n\nОТРЕДАКТИРОВАННЫЙ текст.' }),
        {
          title: 'Политика конфиденциальности',
          content: '# Политика\n\nФинальный утверждённый текст.',
        },
        null,
      );
      expect(action).toEqual({ kind: 'diverged' });
    });

    it('does NOT overwrite when only the title changed', () => {
      const doc = source();
      expect(
        decideLegalSeedAction(
          doc,
          { title: 'Другое название', content: doc.content },
          null,
        ),
      ).toEqual({ kind: 'diverged' });
    });

    it('detects a whitespace-only difference rather than ignoring it', () => {
      // Byte comparison: legal text is not normalized, so a reflowed paragraph
      // is a real change to what the document says on the page.
      const doc = source();
      expect(
        decideLegalSeedAction(
          doc,
          { title: doc.title, content: doc.content + '\n' },
          null,
        ),
      ).toEqual({ kind: 'diverged' });
    });

    it('never returns a write action for approved text', () => {
      // The invariant that matters: whatever the inputs, an approved row is
      // never refreshed or recreated.
      for (const supersededBy of [null, 2]) {
        const action = decideLegalSeedAction(
          source({ content: 'совершенно другой текст' }),
          { title: 'T', content: 'утверждённый текст' },
          supersededBy,
        );
        expect(['preserve', 'diverged']).toContain(action.kind);
      }
    });
  });

  describe('new version', () => {
    it('creates v2 as active while v1 exists but is not the active row', () => {
      // supersededBy is null because no OTHER version is active yet.
      expect(decideLegalSeedAction(source({ version: 2 }), null, null)).toEqual({
        kind: 'create',
        isActive: true,
      });
    });

    it('leaves v1 untouched once it holds approved text', () => {
      const v1 = source({ version: 1 });
      expect(
        decideLegalSeedAction(v1, { title: v1.title, content: v1.content }, 2),
      ).toEqual({ kind: 'preserve' });
    });
  });

  describe('idempotency', () => {
    it('is a no-op on the second run after a refresh', () => {
      const doc = source();
      const first = decideLegalSeedAction(
        doc,
        { title: doc.title, content: PLACEHOLDER },
        null,
      );
      expect(first.kind).toBe('refresh');

      // Simulate the row the refresh just wrote.
      const second = decideLegalSeedAction(
        doc,
        { title: doc.title, content: doc.content },
        null,
      );
      expect(second).toEqual({ kind: 'preserve' });
    });

    it('is a no-op on the second run after a create', () => {
      const doc = source();
      expect(decideLegalSeedAction(doc, null, null).kind).toBe('create');
      expect(
        decideLegalSeedAction(
          doc,
          { title: doc.title, content: doc.content },
          null,
        ),
      ).toEqual({ kind: 'preserve' });
    });
  });
});
