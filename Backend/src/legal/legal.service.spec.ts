// Unit tests for LegalService — the consent rules. Prisma is mocked (no DB).
//
// What these guard, in order of how badly they'd hurt if broken:
//   • a client CANNOT decide which version counts as current (§10, §23);
//   • an invalid claim writes NOTHING at all (§11 — the atomicity boundary);
//   • a superseded acceptance is correctly reported as "must re-accept" (§9);
//   • a missing translation never turns into a missing document (§8);
//   • a retried submit does not stack duplicate evidence (§12).

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LegalDocumentType } from '@prisma/client';
import { LegalService } from './legal.service';

const EFFECTIVE_AT = new Date('2026-08-31T00:00:00.000Z');
const ACCEPTED_AT = new Date('2026-08-31T12:33:10.000Z');

function doc(over: Partial<Record<string, unknown>> = {}) {
  const type = (over.type as LegalDocumentType) ?? LegalDocumentType.TERMS_OF_USE;
  const version = (over.version as number) ?? 1;
  const locale = (over.locale as string) ?? 'ru';
  return {
    id: `${type}_v${version}_${locale}`,
    type,
    version,
    locale,
    title: `title ${type}`,
    content: `content ${type}`,
    contentFormat: 'markdown',
    isActive: true,
    effectiveAt: EFFECTIVE_AT,
    createdAt: EFFECTIVE_AT,
    updatedAt: EFFECTIVE_AT,
    ...over,
  };
}

/**
 * Every required document, active at v1 in all three shipped locales — the same
 * shape the real seed produces (9 rows), so locale behaviour is exercised
 * against a faithful catalogue rather than a reduced one.
 */
function defaultCatalogue() {
  return Object.values(LegalDocumentType).flatMap((type) =>
    ['ru', 'uz', 'en'].map((locale) => doc({ type, locale, version: 1 })),
  );
}

function acceptanceRow(over: Partial<Record<string, unknown>> = {}) {
  const document = (over.document as ReturnType<typeof doc>) ?? doc();
  return {
    id: `acc_${document.id}`,
    userId: 'user_1',
    documentId: document.id,
    documentVersion: document.version,
    acceptedAt: ACCEPTED_AT,
    ipAddress: null,
    userAgent: null,
    locale: 'ru',
    document,
    ...over,
  };
}

/**
 * Prisma double backed by in-memory arrays, so findFirst/findUnique actually
 * apply the where-clauses the service relies on (isActive, locale, version).
 * A bare jest.fn() per call would let a wrong query pass silently.
 */
function makePrismaMock(
  documents = defaultCatalogue(),
  acceptances: ReturnType<typeof acceptanceRow>[] = [],
) {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const legalDocument = {
    findFirst: jest.fn(({ where = {}, orderBy }: any = {}) => {
      const found = documents.filter((d) => matches(d as any, where));
      if (orderBy?.locale === 'asc') {
        found.sort((a, b) => a.locale.localeCompare(b.locale));
      }
      if (orderBy?.version === 'desc') found.sort((a, b) => b.version - a.version);
      return Promise.resolve(found[0] ?? null);
    }),
    findUnique: jest.fn(({ where }: any) => {
      const key = where.type_version_locale;
      return Promise.resolve(
        documents.find(
          (d) =>
            d.type === key.type && d.version === key.version && d.locale === key.locale,
        ) ?? null,
      );
    }),
  };

  const legalAcceptance = {
    findMany: jest.fn(({ where = {}, include, select, orderBy }: any = {}) => {
      let found = acceptances.filter((a) => {
        if (where.userId !== undefined && a.userId !== where.userId) return false;
        if (where.documentId?.in && !where.documentId.in.includes(a.documentId)) {
          return false;
        }
        // Relation filter `document: { type: { in: [...] } }` — resolved through
        // the documents array exactly as the DB join would, so a test cannot
        // pass just because the mock ignored the clause.
        const types = where.document?.type?.in;
        if (types) {
          const doc = documents.find((d) => d.id === a.documentId);
          if (!doc || !types.includes(doc.type)) return false;
        }
        return true;
      });
      if (Array.isArray(orderBy)) {
        found = [...found].sort(
          (a, b) =>
            a.documentVersion - b.documentVersion ||
            a.acceptedAt.getTime() - b.acceptedAt.getTime(),
        );
      }
      // Model Prisma's `include`: resolve the relation from the document array,
      // exactly as the DB join would. Without this the service's grouping reads
      // undefined and the test would pass or fail on the mock's shape.
      // Both `include: { document: true }` and
      // `select: { …, document: { select: { type: true } } }` resolve the
      // relation; production uses each in a different place.
      const withDoc = (a: any) => ({
        ...a,
        document: documents.find((d) => d.id === a.documentId)!,
      });
      if (include?.document) return Promise.resolve(found.map(withDoc));
      if (select?.document) return Promise.resolve(found.map(withDoc));
      return Promise.resolve(found);
    }),
    createMany: jest.fn(({ data }: any) => {
      acceptances.push(
        ...data.map((row: any) => ({
          ...row,
          id: `acc_${row.documentId}`,
          acceptedAt: ACCEPTED_AT,
        })),
      );
      return Promise.resolve({ count: data.length });
    }),
  };

  const prisma: any = { legalDocument, legalAcceptance };
  prisma.$transaction = (cb: (tx: unknown) => unknown) => cb(prisma);
  return prisma as {
    legalDocument: typeof legalDocument;
    legalAcceptance: typeof legalAcceptance;
    $transaction: (cb: (tx: unknown) => unknown) => unknown;
  };
}

const ALL_CURRENT = [
  { type: LegalDocumentType.TERMS_OF_USE, version: 1 },
  { type: LegalDocumentType.PRIVACY_POLICY, version: 1 },
  { type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 1 },
];

describe('LegalService', () => {
  describe('listCurrentDocuments', () => {
    it('returns all three required documents in the requested locale', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      const res = await service.listCurrentDocuments('ru');

      expect(res).toHaveLength(3);
      expect(res.map((d) => d.type).sort()).toEqual(
        [...Object.values(LegalDocumentType)].sort(),
      );
      expect(res.every((d) => d.locale === 'ru')).toBe(true);
    });

    it('serves the uz translation when uz is requested', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      const res = await service.listCurrentDocuments('uz');

      expect(res.every((d) => d.locale === 'uz')).toBe(true);
    });

    it('falls back to the default locale when the translation is missing', async () => {
      // Only ru exists; an `en` client must still get a readable document.
      const ruOnly = Object.values(LegalDocumentType).map((type) =>
        doc({ type, locale: 'ru' }),
      );
      const service = new LegalService(makePrismaMock(ruOnly) as never);

      const res = await service.listCurrentDocuments('en');

      expect(res).toHaveLength(3);
      expect(res.every((d) => d.locale === 'ru')).toBe(true);
    });

    it('never returns an INACTIVE version as the current one', async () => {
      const documents = Object.values(LegalDocumentType).flatMap((type) => [
        doc({ type, locale: 'ru', version: 1, isActive: false }),
        doc({ type, locale: 'ru', version: 2, isActive: true }),
      ]);
      const service = new LegalService(makePrismaMock(documents) as never);

      const res = await service.listCurrentDocuments('ru');

      expect(res.every((d) => d.version === 2)).toBe(true);
    });

    it('matches the response contract and leaks no internal fields', async () => {
      const service = new LegalService(makePrismaMock() as never);

      const [first] = await service.listCurrentDocuments('ru');

      expect(Object.keys(first).sort()).toEqual(
        [
          'content',
          'content_format',
          'effective_at',
          'is_required',
          'locale',
          'title',
          'type',
          'version',
        ].sort(),
      );
      expect(first.effective_at).toBe(EFFECTIVE_AT.toISOString());
      expect(first.is_required).toBe(true);
      // id / isActive / createdAt / updatedAt must never reach the client.
      expect(first).not.toHaveProperty('id');
      expect(first).not.toHaveProperty('isActive');
    });
  });

  describe('getDocumentVersion', () => {
    it('serves a SUPERSEDED version and marks it not-required', async () => {
      const documents = [
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 1, isActive: false }),
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 2, isActive: true }),
      ];
      const service = new LegalService(makePrismaMock(documents) as never);

      const res = await service.getDocumentVersion(
        LegalDocumentType.PRIVACY_POLICY,
        1,
        'ru',
      );

      expect(res.version).toBe(1);
      expect(res.is_required).toBe(false);
    });

    it('404s on a version that does not exist', async () => {
      const service = new LegalService(makePrismaMock() as never);

      await expect(
        service.getDocumentVersion(LegalDocumentType.PRIVACY_POLICY, 99, 'ru'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getStatus', () => {
    it('reports requires_acceptance for a brand-new user', async () => {
      const service = new LegalService(makePrismaMock() as never);

      const res = await service.getStatus('user_1', 'ru');

      expect(res.requires_acceptance).toBe(true);
      expect(res.documents).toHaveLength(3);
      expect(res.documents.every((d) => d.accepted === false)).toBe(true);
      expect(res.documents.every((d) => d.accepted_version === null)).toBe(true);
      expect(res.documents.every((d) => d.accepted_at === undefined)).toBe(true);
    });

    it('reports requires_acceptance = false once everything is accepted', async () => {
      const documents = defaultCatalogue();
      const accepted = Object.values(LegalDocumentType).map((type) =>
        acceptanceRow({
          document: documents.find((d) => d.type === type && d.locale === 'ru')!,
        }),
      );
      const service = new LegalService(makePrismaMock(documents, accepted) as never);

      const res = await service.getStatus('user_1', 'ru');

      expect(res.requires_acceptance).toBe(false);
      expect(res.documents.every((d) => d.accepted)).toBe(true);
      expect(res.documents.every((d) => d.accepted_at === ACCEPTED_AT.toISOString())).toBe(
        true,
      );
    });

    it('requires re-acceptance after a document is re-issued at v2', async () => {
      const documents = [
        doc({ type: LegalDocumentType.TERMS_OF_USE, version: 1 }),
        // Privacy moved to v2; v1 is retired but retained.
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 1, isActive: false }),
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 2 }),
        doc({ type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 1 }),
      ];
      const accepted = [
        acceptanceRow({ document: documents[0] }),
        acceptanceRow({ document: documents[1] }), // accepted the OLD privacy v1
        acceptanceRow({ document: documents[3] }),
      ];
      const service = new LegalService(makePrismaMock(documents, accepted) as never);

      const res = await service.getStatus('user_1', 'ru');

      expect(res.requires_acceptance).toBe(true);
      const privacy = res.documents.find(
        (d) => d.type === LegalDocumentType.PRIVACY_POLICY,
      )!;
      expect(privacy.required_version).toBe(2);
      expect(privacy.accepted_version).toBe(1);
      expect(privacy.accepted).toBe(false);
      // The old acceptance date is still reported, so the client can say
      // "you agreed to v1 on <date>" rather than "not accepted".
      expect(privacy.accepted_at).toBe(ACCEPTED_AT.toISOString());
      // The untouched documents stay accepted — only the re-issued one reopens.
      expect(
        res.documents
          .filter((d) => d.type !== LegalDocumentType.PRIVACY_POLICY)
          .every((d) => d.accepted),
      ).toBe(true);
    });

    it('compares by VERSION, so a rollback does not un-consent a user', async () => {
      // Active version is v1 again; the user already accepted v2.
      const v1 = doc({ type: LegalDocumentType.TERMS_OF_USE, version: 1 });
      const v2 = doc({ type: LegalDocumentType.TERMS_OF_USE, version: 2, isActive: false });
      const documents = [
        v1,
        v2,
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 1 }),
        doc({ type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 1 }),
      ];
      const accepted = [
        acceptanceRow({ document: v2 }),
        acceptanceRow({ document: documents[2] }),
        acceptanceRow({ document: documents[3] }),
      ];
      const service = new LegalService(makePrismaMock(documents, accepted) as never);

      const res = await service.getStatus('user_1', 'ru');

      expect(res.requires_acceptance).toBe(false);
    });
  });

  describe('accept', () => {
    it('records every current document with provenance and locale', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      const res = await service.accept('user_1', ALL_CURRENT, {
        ipAddress: '203.0.113.7',
        userAgent: 'MatorApp/1.2 (iOS 18)',
        locale: 'ru',
      });

      expect(prisma.legalAcceptance.createMany).toHaveBeenCalledTimes(1);
      const written = prisma.legalAcceptance.createMany.mock.calls[0][0].data;
      expect(written).toHaveLength(3);
      for (const row of written) {
        expect(row.userId).toBe('user_1');
        expect(row.documentVersion).toBe(1);
        expect(row.ipAddress).toBe('203.0.113.7');
        expect(row.userAgent).toBe('MatorApp/1.2 (iOS 18)');
        expect(row.locale).toBe('ru');
        // acceptedAt is the DB default (CURRENT_TIMESTAMP) — not client-supplied.
        expect(row).not.toHaveProperty('acceptedAt');
      }
      expect(res.requires_acceptance).toBe(false);
    });

    it('REJECTS a stale version instead of trusting the client', async () => {
      const documents = [
        doc({ type: LegalDocumentType.TERMS_OF_USE, version: 1 }),
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 1, isActive: false }),
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 2 }),
        doc({ type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 1 }),
      ];
      const prisma = makePrismaMock(documents);
      const service = new LegalService(prisma as never);

      // Client claims privacy v1 while v2 is in force.
      await expect(
        service.accept('user_1', ALL_CURRENT, { locale: 'ru' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.legalAcceptance.createMany).not.toHaveBeenCalled();
    });

    it('rejects a request that omits a required document', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      await expect(
        service.accept(
          'user_1',
          [{ type: LegalDocumentType.TERMS_OF_USE, version: 1 }],
          { locale: 'ru' },
        ),
      ).rejects.toMatchObject({
        response: { code: 'LEGAL_ACCEPTANCE_REQUIRED' },
      });
      expect(prisma.legalAcceptance.createMany).not.toHaveBeenCalled();
    });

    it('rejects a duplicated document type', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      await expect(
        service.accept(
          'user_1',
          [
            { type: LegalDocumentType.PRIVACY_POLICY, version: 1 },
            { type: LegalDocumentType.PRIVACY_POLICY, version: 1 },
            { type: LegalDocumentType.TERMS_OF_USE, version: 1 },
            { type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 1 },
          ],
          { locale: 'ru' },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.legalAcceptance.createMany).not.toHaveBeenCalled();
    });

    it('writes NOTHING when only the LAST document is invalid (atomicity)', async () => {
      const documents = [
        doc({ type: LegalDocumentType.TERMS_OF_USE, version: 1 }),
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 1 }),
        doc({ type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 3 }),
      ];
      const prisma = makePrismaMock(documents);
      const service = new LegalService(prisma as never);

      // First two claims are correct; the third is stale.
      await expect(
        service.accept('user_1', ALL_CURRENT, { locale: 'ru' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The critical assertion: validation completes BEFORE any insert, so the
      // two valid documents left no half-consent behind.
      expect(prisma.legalAcceptance.createMany).not.toHaveBeenCalled();
    });

    it('is idempotent under retry — no duplicate evidence for one version', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      await service.accept('user_1', ALL_CURRENT, { locale: 'ru' });
      await service.accept('user_1', ALL_CURRENT, { locale: 'ru' });

      // Second call finds all three already accepted and writes nothing more.
      expect(prisma.legalAcceptance.createMany).toHaveBeenCalledTimes(1);
      const res = await service.getStatus('user_1', 'ru');
      expect(res.requires_acceptance).toBe(false);
    });

    it('still records a NEW version after one was already accepted (history kept)', async () => {
      const documents = defaultCatalogue();
      const prisma = makePrismaMock(documents);
      const service = new LegalService(prisma as never);

      await service.accept('user_1', ALL_CURRENT, { locale: 'ru' });

      // Privacy is re-issued as v2.
      const privacyRu = documents.find(
        (d) => d.type === LegalDocumentType.PRIVACY_POLICY && d.locale === 'ru',
      )!;
      privacyRu.isActive = false;
      documents.push(
        doc({ type: LegalDocumentType.PRIVACY_POLICY, locale: 'ru', version: 2 }),
      );

      await service.accept(
        'user_1',
        [
          { type: LegalDocumentType.TERMS_OF_USE, version: 1 },
          { type: LegalDocumentType.PRIVACY_POLICY, version: 2 },
          { type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 1 },
        ],
        { locale: 'ru' },
      );

      // A second write happened, and it carried ONLY the newly-required version:
      // the v1 acceptance is untouched, so the consent history survives.
      expect(prisma.legalAcceptance.createMany).toHaveBeenCalledTimes(2);
      const second = prisma.legalAcceptance.createMany.mock.calls[1][0].data;
      expect(second).toHaveLength(1);
      expect(second[0].documentVersion).toBe(2);

      const res = await service.getStatus('user_1', 'ru');
      expect(res.requires_acceptance).toBe(false);
    });

    it('truncates oversized provenance rather than failing the write', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      await service.accept('user_1', ALL_CURRENT, {
        ipAddress: 'x'.repeat(120),
        userAgent: 'y'.repeat(900),
        locale: 'ru',
      });

      const [row] = prisma.legalAcceptance.createMany.mock.calls[0][0].data;
      expect(row.ipAddress).toHaveLength(45);
      expect(row.userAgent).toHaveLength(500);
    });

    it('stores null provenance when the proxy supplied none', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      await service.accept('user_1', ALL_CURRENT, {
        ipAddress: null,
        userAgent: undefined,
        locale: 'ru',
      });

      const [row] = prisma.legalAcceptance.createMany.mock.calls[0][0].data;
      expect(row.ipAddress).toBeNull();
      expect(row.userAgent).toBeNull();
    });
  });


  describe('locale independence of consent (audit regressions)', () => {
    it('re-accepting the SAME version in ANOTHER language adds no second row', async () => {
      // Regression: dedup once keyed on documentId, which is per-locale, so
      // accepting in ru and then en stacked a second row for the same
      // instrument. Consent is to (document, version); the language is
      // provenance, not part of what was agreed to.
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      await service.accept('user_1', ALL_CURRENT, { locale: 'ru' });
      await service.accept('user_1', ALL_CURRENT, { locale: 'en' });

      expect(prisma.legalAcceptance.createMany).toHaveBeenCalledTimes(1);
      const rows = prisma.legalAcceptance.createMany.mock.calls[0][0].data;
      expect(rows).toHaveLength(3);
    });

    it('keeps consent valid when the user switches language', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      await service.accept('user_1', ALL_CURRENT, { locale: 'ru' });

      // The acceptance was recorded against the ru rows; asking in uz/en must
      // still report it as accepted — version is the unit of consent.
      for (const lang of ['ru', 'uz', 'en'] as const) {
        const res = await service.getStatus('user_1', lang);
        expect(res.requires_acceptance).toBe(false);
        expect(res.documents.every((d) => d.accepted_version === 1)).toBe(true);
      }
    });

    it('still records a genuine v1 -> v2 upgrade across languages', async () => {
      const documents = defaultCatalogue();
      const prisma = makePrismaMock(documents);
      const service = new LegalService(prisma as never);

      await service.accept('user_1', ALL_CURRENT, { locale: 'ru' });

      for (const locale of ['ru', 'uz']) {
        documents.find(
          (d) => d.type === LegalDocumentType.PRIVACY_POLICY && d.locale === locale,
        )!.isActive = false;
        documents.push(
          doc({ type: LegalDocumentType.PRIVACY_POLICY, locale, version: 2 }),
        );
      }

      // Accepted in a DIFFERENT language than the v1 consent — must still write.
      await service.accept(
        'user_1',
        [
          { type: LegalDocumentType.TERMS_OF_USE, version: 1 },
          { type: LegalDocumentType.PRIVACY_POLICY, version: 2 },
          { type: LegalDocumentType.PERSONAL_DATA_CONSENT, version: 1 },
        ],
        { locale: 'uz' },
      );

      const second = prisma.legalAcceptance.createMany.mock.calls[1][0].data;
      expect(second).toHaveLength(1);
      expect(second[0].documentVersion).toBe(2);
      expect(second[0].locale).toBe('uz');
    });
  });

  describe('public exposure of unpublished drafts', () => {
    it('REFUSES to serve an inactive version NEWER than the active one', async () => {
      // A drafted-but-unpublished v2 must not be readable by anonymous callers:
      // the endpoint is public and the wording has no legal effect yet.
      const documents = [
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 1, isActive: true }),
        doc({
          type: LegalDocumentType.PRIVACY_POLICY,
          version: 2,
          isActive: false,
          content: 'unpublished draft',
        }),
      ];
      const service = new LegalService(makePrismaMock(documents) as never);

      await expect(
        service.getDocumentVersion(LegalDocumentType.PRIVACY_POLICY, 2, 'ru'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('still serves a SUPERSEDED version (the point of the endpoint)', async () => {
      const documents = [
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 1, isActive: false }),
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 2, isActive: true }),
      ];
      const service = new LegalService(makePrismaMock(documents) as never);

      const res = await service.getDocumentVersion(
        LegalDocumentType.PRIVACY_POLICY,
        1,
        'ru',
      );
      expect(res.version).toBe(1);
      expect(res.is_required).toBe(false);
    });

    it('serves the ACTIVE version', async () => {
      const service = new LegalService(makePrismaMock() as never);
      const res = await service.getDocumentVersion(
        LegalDocumentType.PRIVACY_POLICY,
        1,
        'ru',
      );
      expect(res.version).toBe(1);
      expect(res.is_required).toBe(true);
    });

    it('serves nothing at all when no version is published yet', async () => {
      const documents = [
        doc({ type: LegalDocumentType.PRIVACY_POLICY, version: 1, isActive: false }),
      ];
      const service = new LegalService(makePrismaMock(documents) as never);

      await expect(
        service.getDocumentVersion(LegalDocumentType.PRIVACY_POLICY, 1, 'ru'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('English support end to end', () => {
    it('serves all three documents in en and records consent given in en', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);

      const documents = await service.listCurrentDocuments('en');
      expect(documents).toHaveLength(3);
      expect(documents.every((d) => d.locale === 'en')).toBe(true);

      await service.accept('user_1', ALL_CURRENT, {
        locale: 'en',
        ipAddress: '203.0.113.9',
        userAgent: 'MatorApp/2.0',
      });

      const rows = prisma.legalAcceptance.createMany.mock.calls[0][0].data;
      expect(rows.every((r: any) => r.locale === 'en')).toBe(true);
      // The consent points at the EN document rows.
      expect(rows.every((r: any) => r.documentId.endsWith('_en'))).toBe(true);
    });
  });

  describe('hasAcceptedAllRequired', () => {
    it('is false for a user who accepted nothing', async () => {
      const service = new LegalService(makePrismaMock() as never);
      await expect(service.hasAcceptedAllRequired('user_1')).resolves.toBe(false);
    });

    it('is true once every required document is accepted at its current version', async () => {
      const prisma = makePrismaMock();
      const service = new LegalService(prisma as never);
      await service.accept('user_1', ALL_CURRENT, { locale: 'ru' });
      await expect(service.hasAcceptedAllRequired('user_1')).resolves.toBe(true);
    });
  });
});
