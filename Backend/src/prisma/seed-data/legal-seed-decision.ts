import { LegalDocumentSeedSource } from './legal-documents.loader';
import { isPlaceholderLegalContent } from './legal-documents.loader';

/**
 * What the seed should do with one source file, given what the database holds.
 *
 * Extracted from seedLegalDocuments so the rules that decide whether approved
 * legal text gets overwritten are testable without a database. That matters
 * more here than in most seeds: the failure mode is not a bad row, it is a
 * published document silently changing under acceptances that point at it.
 */
export type LegalSeedAction =
  /** No row for this (type, version, locale) — insert it. */
  | { kind: 'create'; isActive: boolean }
  /** Row exists but holds placeholder text — safe to replace in place. */
  | { kind: 'refresh'; isActive: boolean }
  /** Row holds approved text identical to the source — nothing to do. */
  | { kind: 'preserve' }
  /**
   * Row holds approved text that DIFFERS from the source. Not written: the
   * database is what users accepted. Reported so the divergence is visible.
   */
  | { kind: 'diverged' };

/** The subset of a stored row the decision depends on. */
export interface StoredLegalDocument {
  title: string;
  content: string;
}

/**
 * Decide the action for one source row.
 *
 * @param source        the file's contents.
 * @param existing      the stored row for this exact (type, version, locale), or null.
 * @param supersededBy  the version currently active for this (type, locale), when it
 *                      is a DIFFERENT version — such a row must not be activated,
 *                      or two versions of one document would be in force at once.
 */
export function decideLegalSeedAction(
  source: LegalDocumentSeedSource,
  existing: StoredLegalDocument | null,
  supersededBy: number | null,
): LegalSeedAction {
  const isActive = supersededBy === null;

  if (!existing) return { kind: 'create', isActive };

  // Placeholder rows are structurally correct but legally meaningless, so
  // replacing one in place is safe and is how approved text first lands.
  if (isPlaceholderLegalContent(existing.content)) {
    return { kind: 'refresh', isActive };
  }

  // Approved text. Byte-identical means the seed has nothing to do; any
  // difference means the source file was edited after publication, which is a
  // version bump, not an edit — so the stored text stands and the caller
  // reports it.
  if (existing.content === source.content && existing.title === source.title) {
    return { kind: 'preserve' };
  }
  return { kind: 'diverged' };
}
