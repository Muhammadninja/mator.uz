import { Prisma } from '@prisma/client';

import { LEGAL_DATE_BLANK } from './legal-documents.loader';
import { legalDocumentSeed, type LegalDocumentSeed } from './legal-documents.seed';
import { decideLegalSeedAction, type LegalSeedAction } from './legal-seed-decision';

/**
 * Publishes `docs/legal/*.md` into `legal_documents`, touching NOTHING else.
 *
 * Shared by `npm run seed` and `npm run seed:legal`. The second exists for
 * production: the full seed rewrites reference data (dealers, categories, …),
 * while this only ever creates document rows, refreshes placeholder rows, and
 * aligns `effective_at` with the date the text states.
 *
 * Two phases, so a dry run shows exactly what an apply would do:
 *   1. plan  — reads only, decides one step per source file;
 *   2. apply — every write of the plan in ONE transaction, so a version is
 *              published in all three languages or in none.
 *
 * Idempotent: a second run plans nothing but `preserve` steps.
 *
 * Per source file:
 *   • no effective date in the text (`__.__.____`) and no row → not published;
 *   • no row                     → created (active unless another version of
 *                                   the same document is in force);
 *   • placeholder row            → title/content replaced in place;
 *   • approved row, same text    → left alone;
 *   • approved row, CHANGED text → left alone and reported: published wording
 *                                   is never rewritten, a change is a new version;
 *   • in every case but the last, `effective_at` is set to the text's date when
 *     it differs — the date users read and the stored date must be one.
 */

/** The client surface this module needs: the table, and a transaction. */
export interface LegalPublishDb {
  legalDocument: Pick<
    Prisma.TransactionClient['legalDocument'],
    'findUnique' | 'findFirst' | 'create' | 'update' | 'count'
  >;
  $transaction<T>(fn: (tx: LegalPublishTx) => Promise<T>): Promise<T>;
}
type LegalPublishTx = Pick<LegalPublishDb, 'legalDocument'>;

export type LegalPublishStep = {
  /** "TERMS_OF_USE v2 (ru)" */
  label: string;
  source: LegalDocumentSeed;
  action: LegalSeedAction | { kind: 'undated' };
  existingId: string | null;
  /** Set when the stored effective date is not the one the text states. */
  dateFix: { from: Date; to: Date } | null;
};

export type LegalPublishReport = {
  dryRun: boolean;
  steps: LegalPublishStep[];
  /** Active rows still holding placeholder text, after this run. */
  stillPlaceholder: number;
};

export async function planLegalPublication(
  db: Pick<LegalPublishDb, 'legalDocument'>,
  sources: LegalDocumentSeed[],
): Promise<LegalPublishStep[]> {
  // Versions this plan will activate, so two versions of one document created
  // in the same run cannot both become active (sources come sorted, v1 first).
  const plannedActive = new Map<string, number>();
  const steps: LegalPublishStep[] = [];

  for (const source of sources) {
    const label = `${source.type} v${source.version} (${source.locale})`;
    const existing = await db.legalDocument.findUnique({
      where: {
        type_version_locale: {
          type: source.type,
          version: source.version,
          locale: source.locale,
        },
      },
    });

    if (!existing && source.effectiveAt === null) {
      steps.push({ label, source, action: { kind: 'undated' }, existingId: null, dateFix: null });
      continue;
    }

    const activeElsewhere = await db.legalDocument.findFirst({
      where: {
        type: source.type,
        locale: source.locale,
        isActive: true,
        version: { not: source.version },
      },
      select: { version: true },
    });
    const planKey = `${source.type}|${source.locale}`;
    const planned = plannedActive.get(planKey);
    const supersededBy =
      activeElsewhere?.version ?? (planned !== undefined && planned !== source.version ? planned : null);

    const action = decideLegalSeedAction(source, existing, supersededBy);
    if ((action.kind === 'create' || action.kind === 'refresh') && action.isActive) {
      plannedActive.set(planKey, source.version);
    }

    const dateFix =
      existing &&
      source.effectiveAt &&
      action.kind !== 'diverged' &&
      existing.effectiveAt.getTime() !== source.effectiveAt.getTime()
        ? { from: existing.effectiveAt, to: source.effectiveAt }
        : null;

    steps.push({ label, source, action, existingId: existing?.id ?? null, dateFix });
  }
  return steps;
}

export async function publishLegalDocuments(
  db: LegalPublishDb,
  options: { dryRun?: boolean; sources?: LegalDocumentSeed[] } = {},
): Promise<LegalPublishReport> {
  const dryRun = options.dryRun ?? false;
  // Read at CALL time, not at import: a malformed source file must fail with the
  // loader's diagnostic, not break every importer of this module.
  const sources = options.sources ?? legalDocumentSeed();
  const steps = await planLegalPublication(db, sources);

  if (!dryRun) {
    await db.$transaction(async (tx) => {
      for (const step of steps) {
        const { source, action } = step;
        if (action.kind === 'create') {
          await tx.legalDocument.create({
            data: {
              type: source.type,
              version: source.version,
              locale: source.locale,
              title: source.title,
              content: source.content,
              contentFormat: 'markdown',
              isActive: action.isActive,
              // Never null here: an undated source with no row is not created.
              effectiveAt: source.effectiveAt!,
            },
          });
        } else if (action.kind === 'refresh' || step.dateFix) {
          await tx.legalDocument.update({
            where: { id: step.existingId! },
            data: {
              ...(action.kind === 'refresh'
                ? { title: source.title, content: source.content, isActive: action.isActive }
                : {}),
              ...(step.dateFix ? { effectiveAt: step.dateFix.to } : {}),
            },
          });
        }
      }
    });
  }

  const stillPlaceholder = await db.legalDocument.count({
    where: { isActive: true, content: { contains: '[PLACEHOLDER' } },
  });
  return { dryRun, steps, stillPlaceholder };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Human summary of a run. Lists every row that is or would be written. */
export function formatLegalPublishReport(report: LegalPublishReport): string[] {
  const lines: string[] = [];
  const verb = report.dryRun ? ' would be' : '';
  const count = (kind: string) => report.steps.filter((s) => s.action.kind === kind);
  const created = count('create');
  const refreshed = count('refresh');
  const undated = count('undated');
  const diverged = count('diverged');
  const dateFixes = report.steps.filter((s) => s.dateFix);
  const inactive = report.steps.filter(
    (s) => (s.action.kind === 'create' || s.action.kind === 'refresh') && !s.action.isActive,
  );

  lines.push(
    `[legal] ${report.dryRun ? 'DRY RUN — nothing written. ' : ''}` +
      `${created.length}${verb} created, ${refreshed.length} placeholder(s)${verb} refreshed, ` +
      `${dateFixes.length} effective date(s)${verb} corrected, ` +
      `${count('preserve').length} unchanged, ${undated.length} not published (no date).`,
  );
  for (const s of created) {
    lines.push(
      `         + ${s.label} effective ${day(s.source.effectiveAt!)}` +
        `${'isActive' in s.action && !s.action.isActive ? ' (INACTIVE: a newer/other version is in force)' : ''}`,
    );
  }
  for (const s of refreshed) lines.push(`         ~ ${s.label} placeholder replaced`);
  for (const s of dateFixes) {
    lines.push(`         ~ ${s.label} effective_at ${day(s.dateFix!.from)} → ${day(s.dateFix!.to)}`);
  }
  if (inactive.length > 0) {
    lines.push(
      '[legal] Inactive rows are drafts until activated in the database (one active version per document and language).',
    );
  }
  if (undated.length > 0) {
    lines.push(
      `[legal] NOT published — the text still has ${LEGAL_DATE_BLANK} as its effective date:\n` +
        undated.map((s) => `         • ${s.label}`).join('\n'),
    );
  }
  if (diverged.length > 0) {
    lines.push(
      `[legal] WARNING: ${diverged.length} published document(s) differ from their source file and were NOT updated:\n` +
        diverged.map((s) => `         • ${s.label}`).join('\n') +
        '\n         The database holds the text users actually accepted, so it wins.\n' +
        '         To publish new wording, add a new version file and run the seed again.\n' +
        '         To discard the edit, revert the source file to the published text.',
    );
  }
  if (report.stillPlaceholder > 0) {
    lines.push(
      `[legal] WARNING: ${report.stillPlaceholder} active legal document(s) still contain PLACEHOLDER text.\n` +
        '         Users would be consenting to wording no legal owner has approved.',
    );
  }
  return lines;
}
