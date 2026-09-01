import {
  LegalDocumentSeedSource,
  loadLegalDocuments,
} from './legal-documents.loader';

/**
 * Legal documents for the seed.
 *
 * ⚠️ THE LEGAL TEXT IS NOT IN THIS FILE. ⚠️
 *
 * It lives in `Backend/docs/legal/*.md`, one file per (document, version,
 * locale), and is read at seed time by {@link loadLegalDocuments}. See
 * `docs/legal/README.md` for the file naming and front matter rules.
 *
 * The backend must not author, paraphrase or "reasonably approximate" a user
 * agreement, a privacy policy, or a personal-data consent: those are binding
 * instruments whose exact wording carries legal consequence under Uzbek law
 * (incl. the Personal Data Law, No. ZRU-547). Keeping the text in reviewable
 * markdown means the file a lawyer approves is the file that ships — there is
 * no transcription step in between where wording can drift.
 *
 * ── Changing the text ──
 * Edit the relevant `docs/legal/<document>.v<version>.<locale>.md` and re-run
 * `npm run seed`. No backend code change is required.
 *
 * Once real text is published and users have accepted it, that version is
 * FROZEN: the seed will not overwrite it (see seedLegalDocuments). Further
 * changes are a NEW version — add `<document>.v2.<locale>.md` — never an edit,
 * because an acceptance record that points at rewritten text proves nothing.
 */

export type { LegalDocumentSeedSource } from './legal-documents.loader';
export {
  LEGAL_PLACEHOLDER_MARKER,
  LEGAL_LOCALES,
  LegalSourceError,
  getLegalDocsDirectory,
  isPlaceholderLegalContent,
  loadLegalDocuments,
} from './legal-documents.loader';

/** Shape the seed writes. Kept as an alias so callers need not rename. */
export type LegalDocumentSeed = LegalDocumentSeedSource;

/**
 * The date v1 takes effect. Fixed rather than `new Date()` so re-running the
 * seed does not shift the effective date of an already-published document.
 *
 * Publication state (`effectiveAt`, `isActive`) is owned HERE and by the seed,
 * not by the markdown: a source file describes what a document says, while the
 * database decides which version is in force. Letting a file edit flip the
 * active version would make "what must this user accept?" answerable only by
 * reading the filesystem.
 */
export const LEGAL_V1_EFFECTIVE_AT = new Date('2026-08-31T00:00:00.000Z');

/**
 * Every document source, read from `docs/legal`.
 *
 * A function, not a module-level constant: reading the filesystem while a module
 * is being imported would make any importer — including a test that never seeds
 * anything — fail on a malformed file, and would fix the sources at import time
 * so a test could not point the loader at a fixture directory.
 */
export function legalDocumentSeed(): LegalDocumentSeed[] {
  return loadLegalDocuments();
}
