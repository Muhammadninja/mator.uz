import { LegalDocumentType } from '@prisma/client';

import type { LegalDocumentSeed } from './legal-documents.seed';
import { formatLegalPublishReport, publishLegalDocuments } from './legal-documents.publish';

type Row = {
  id: string;
  type: LegalDocumentType;
  version: number;
  locale: string;
  title: string;
  content: string;
  contentFormat: string;
  isActive: boolean;
  effectiveAt: Date;
};

const SEPT_1 = new Date('2026-09-01T00:00:00.000Z');
const AUG_31 = new Date('2026-08-31T00:00:00.000Z');

const source = (over: Partial<LegalDocumentSeed> = {}): LegalDocumentSeed => ({
  type: LegalDocumentType.TERMS_OF_USE,
  version: 1,
  locale: 'ru',
  title: 'T',
  content: 'text',
  effectiveAt: SEPT_1,
  ...over,
});

/** `legal_documents` in memory, applying the where-clauses the module uses. */
function makeDb(rows: Row[] = []) {
  const writes: string[] = [];
  let transactions = 0;
  const legalDocument = {
    findUnique: jest.fn(async ({ where }: any) => {
      const k = where.type_version_locale;
      return rows.find((r) => r.type === k.type && r.version === k.version && r.locale === k.locale) ?? null;
    }),
    findFirst: jest.fn(async ({ where }: any) =>
      rows.find(
        (r) =>
          r.type === where.type &&
          r.locale === where.locale &&
          r.isActive === where.isActive &&
          r.version !== where.version.not,
      ) ?? null,
    ),
    create: jest.fn(async ({ data }: any) => {
      writes.push(`create ${data.type} v${data.version} ${data.locale}`);
      const row = { id: `${data.type}|${data.version}|${data.locale}`, ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      writes.push(`update ${where.id}`);
      Object.assign(rows.find((r) => r.id === where.id)!, data);
      return null;
    }),
    count: jest.fn(async () => rows.filter((r) => r.isActive && r.content.includes('[PLACEHOLDER')).length),
  };
  const db = {
    legalDocument,
    $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
      transactions += 1;
      return fn({ legalDocument });
    }),
  };
  return { db: db as any, rows, writes, transactions: () => transactions };
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 'TERMS_OF_USE|1|ru',
  type: LegalDocumentType.TERMS_OF_USE,
  version: 1,
  locale: 'ru',
  title: 'T',
  content: 'text',
  contentFormat: 'markdown',
  isActive: true,
  effectiveAt: SEPT_1,
  ...over,
});

describe('publishLegalDocuments', () => {
  it('creates a dated document with the date its text states', async () => {
    const { db, rows } = makeDb();
    await publishLegalDocuments(db, { sources: [source()] });
    expect(rows).toHaveLength(1);
    expect(rows[0].effectiveAt).toEqual(SEPT_1);
    expect(rows[0].isActive).toBe(true);
  });

  it('does not publish a document whose date is still blank', async () => {
    const { db, rows } = makeDb();
    const report = await publishLegalDocuments(db, {
      sources: [source({ type: LegalDocumentType.REFUND_POLICY, effectiveAt: null })],
    });
    expect(rows).toHaveLength(0);
    expect(report.steps[0].action.kind).toBe('undated');
    expect(formatLegalPublishReport(report).join('\n')).toContain('NOT published');
  });

  it('is idempotent: a second run writes nothing', async () => {
    const { db, writes } = makeDb();
    const sources = [source(), source({ locale: 'uz' }), source({ locale: 'en' })];
    await publishLegalDocuments(db, { sources });
    writes.length = 0;
    const second = await publishLegalDocuments(db, { sources });
    expect(writes).toEqual([]);
    expect(second.steps.every((s) => s.action.kind === 'preserve' && !s.dateFix)).toBe(true);
  });

  it('a dry run plans the same steps and writes nothing', async () => {
    const { db, writes, transactions } = makeDb([row({ effectiveAt: AUG_31 })]);
    const report = await publishLegalDocuments(db, {
      dryRun: true,
      sources: [source(), source({ type: LegalDocumentType.PRIVACY_POLICY })],
    });
    expect(writes).toEqual([]);
    expect(transactions()).toBe(0);
    expect(report.steps.map((s) => s.action.kind)).toEqual(['preserve', 'create']);
    expect(report.steps[0].dateFix).toEqual({ from: AUG_31, to: SEPT_1 });
    expect(formatLegalPublishReport(report)[0]).toContain('DRY RUN');
  });

  it('writes the whole plan in one transaction', async () => {
    const { db, transactions } = makeDb();
    await publishLegalDocuments(db, {
      sources: [source(), source({ locale: 'uz' }), source({ locale: 'en' })],
    });
    expect(transactions()).toBe(1);
  });

  it('corrects a stored effective date to the one the published text states', async () => {
    // The v1 rows were seeded with 31.08.2026 while their text says 01.09.2026.
    const { db, rows } = makeDb([row({ effectiveAt: AUG_31 })]);
    await publishLegalDocuments(db, { sources: [source()] });
    expect(rows[0].effectiveAt).toEqual(SEPT_1);
    expect(rows[0].content).toBe('text');
  });

  it('never rewrites published text that changed, nor its date', async () => {
    const { db, rows, writes } = makeDb([row({ content: 'accepted text', effectiveAt: AUG_31 })]);
    const report = await publishLegalDocuments(db, { sources: [source({ content: 'edited text' })] });
    expect(writes).toEqual([]);
    expect(rows[0].content).toBe('accepted text');
    expect(report.steps[0].action.kind).toBe('diverged');
  });

  it('creates a new version INACTIVE while another version is in force', async () => {
    const { db, rows } = makeDb([row()]);
    await publishLegalDocuments(db, { sources: [source(), source({ version: 2 })] });
    expect(rows.find((r) => r.version === 2)?.isActive).toBe(false);
    expect(rows.find((r) => r.version === 1)?.isActive).toBe(true);
  });

  it('activates only the first of two new versions created in one run', async () => {
    const { db, rows } = makeDb();
    await publishLegalDocuments(db, { sources: [source(), source({ version: 2 })] });
    expect(rows.find((r) => r.version === 1)?.isActive).toBe(true);
    expect(rows.find((r) => r.version === 2)?.isActive).toBe(false);
  });

  it('replaces a placeholder row in place, with the date', async () => {
    const { db, rows } = makeDb([
      row({ content: '[PLACEHOLDER: FINAL LEGAL TEXT REQUIRED]', effectiveAt: AUG_31 }),
    ]);
    await publishLegalDocuments(db, { sources: [source()] });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('text');
    expect(rows[0].effectiveAt).toEqual(SEPT_1);
  });
});
