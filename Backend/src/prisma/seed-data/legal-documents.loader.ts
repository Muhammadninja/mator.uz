import * as fs from 'fs';
import * as path from 'path';
import { LegalDocumentType } from '@prisma/client';

/**
 * Loads legal document sources from `Backend/docs/legal/*.md`.
 *
 * ── Why the text lives in markdown and not in this directory ────────────────
 * Legal wording is reviewed and approved by people who do not read TypeScript.
 * Keeping it in `.md` means the approved artefact IS the thing that ships:
 * there is no transcription step between what a lawyer signed off and what a
 * user consents to, and `git diff` on a legal change shows prose rather than an
 * escaped template literal.
 *
 * This loader is a SEED-TIME component. The API never calls it — runtime reads
 * come from `legal_documents` (see LegalService), so a served document does not
 * depend on the filesystem being present or readable.
 *
 * ── File naming ────────────────────────────────────────────────────────────
 *   <document>.v<version>.<locale>.md      e.g. privacy-policy.v1.ru.md
 *
 * The version is in BOTH the filename and the front matter, and the two must
 * agree (checked below). The filename carries it so a directory listing shows
 * at a glance which versions exist; the front matter carries it because a
 * filename is not machine-readable metadata — it is a convention that a rename
 * can silently break. Disagreement is a hard error rather than a precedence
 * rule: if the two disagree, which one the author meant is genuinely unknown.
 *
 * Publishing v2 means ADDING `privacy-policy.v2.ru.md`. The v1 file stays: it
 * is the text users accepted, and the acceptance records point at it.
 */

/** One document source, normalized. Mirrors the seed's row shape. */
export interface LegalDocumentSeedSource {
  type: LegalDocumentType;
  version: number;
  locale: string;
  title: string;
  content: string;
}

/** Interface languages the documents ship in (mirrors common/app-lang.util). */
export const LEGAL_LOCALES = ['ru', 'uz', 'en'] as const;
export type LegalLocale = (typeof LEGAL_LOCALES)[number];

/** Marker identifying text that is not yet the approved legal wording. */
export const LEGAL_PLACEHOLDER_MARKER = '[PLACEHOLDER: FINAL LEGAL TEXT REQUIRED]';

/**
 * Editorial markers the drafts carry while they await counsel: clauses flagged
 * for review and company details still to be filled in from the registration
 * documents. Unlike {@link LEGAL_PLACEHOLDER_MARKER} these read as ordinary
 * prose, so nothing downstream would notice them — and once such text is stored
 * and accepted it is frozen (a correction becomes v2). The seed therefore
 * refuses a file that still contains one.
 */
const UNRESOLVED_DRAFT_MARKERS = [
  '[НА ЮРИДИЧЕСКУЮ ПРОВЕРКУ]',
  '[НА ЮРИДИЧЕСКУЮ ПРОВЕРКУ И ТЕХНИЧЕСКУЮ СВЕРКУ ПЕРЕД ПУБЛИКАЦИЕЙ]',
  '[ТЕХНИЧЕСКАЯ СВЕРКА ПЕРЕД ПУБЛИКАЦИЕЙ]',
  '[ИНН',
  '[ЮРИДИЧЕСКИЙ АДРЕС',
  '[АДРЕС',
  '[EMAIL]',
  '[PRIVACY EMAIL]',
  '[ТЕЛЕФОН]',
] as const;

/** Every (type, locale) pair that must exist for the seed to be complete. */
const REQUIRED_SOURCE_COUNT =
  Object.keys(LegalDocumentType).length * LEGAL_LOCALES.length;

/** `<document>.v<version>.<locale>.md` */
const FILENAME_PATTERN = /^([a-z0-9-]+)\.v(\d+)\.([a-z]{2})\.md$/;

/** Thrown for any malformed or incomplete source set. Fails the seed. */
export class LegalSourceError extends Error {
  constructor(message: string) {
    super(`[legal sources] ${message}`);
    this.name = 'LegalSourceError';
  }
}

/**
 * Locate `Backend/docs/legal`, from wherever this module happens to be running.
 *
 * Walks UP from this file looking for a directory that contains `docs/legal`.
 * Deliberately not `process.cwd()`-relative: the seed is invoked as
 * `npm run seed` from the project root today, but a cron entry, a container
 * ENTRYPOINT or a Prisma-invoked seed can each have a different working
 * directory, and a path that silently resolves to the wrong place would produce
 * "no sources found" rather than an obvious failure.
 *
 * Walking up from `__dirname` also survives compilation: from `src/prisma/
 * seed-data` it climbs to `Backend/`, and from `dist/src/prisma/seed-data` it
 * climbs past `dist/` to the same `Backend/`. That matters because `docs/` is
 * NOT copied into `dist` by `tsc` — a `dist`-relative path would break the
 * moment the seed ran from compiled output.
 */
export function getLegalDocsDirectory(): string {
  let dir = __dirname;
  // Bounded by reaching the filesystem root, where dirname() is a fixed point.
  for (;;) {
    const candidate = path.join(dir, 'docs', 'legal');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new LegalSourceError(
    `Could not locate docs/legal walking up from ${__dirname}. ` +
      'The legal text lives there and the seed cannot run without it; ' +
      'if this is a deployed environment, confirm docs/ ships with the app.',
  );
}

/**
 * Split `---\n…\n---\n` front matter from the markdown body.
 *
 * A deliberately minimal parser rather than a YAML dependency: the front matter
 * is a fixed set of four scalar keys, and `validateMetadata` rejects anything it
 * does not recognise, so the expressive power of YAML is not needed here — and
 * a parser that accepts anchors, aliases and arbitrary types would widen what a
 * legal source file can express well beyond what this loader can validate.
 */
function parseFrontMatter(
  raw: string,
  filename: string,
): { meta: Record<string, string>; body: string } {
  // Tolerate a UTF-8 BOM and leading blank lines from an editor.
  const text = raw.replace(/^﻿/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!match) {
    throw new LegalSourceError(
      `${filename}: missing or malformed front matter. The file must start with ` +
        'a `---` line, contain `key: value` pairs, and close with another `---`.',
    );
  }

  const meta: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new LegalSourceError(
        `${filename}: front matter line ${index + 1} is not \`key: value\`: "${line}".`,
      );
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    // Strip one layer of matching quotes — titles contain spaces and commas and
    // are conventionally quoted.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key in meta) {
      throw new LegalSourceError(
        `${filename}: duplicate front matter key "${key}".`,
      );
    }
    meta[key] = value;
  }

  return { meta, body: text.slice(match[0].length) };
}

/** Type guard over the Prisma enum, so an unknown `type:` cannot reach the DB. */
function isLegalDocumentType(value: string): value is LegalDocumentType {
  return Object.prototype.hasOwnProperty.call(LegalDocumentType, value);
}

/**
 * Validate one file's metadata and body into a source row.
 *
 * Every check is fatal. A legal document that is silently wrong — the correct
 * text filed under the wrong locale, say — is worse than a seed that refuses to
 * run: it produces consent records pointing at the wrong instrument.
 */
function toSource(
  meta: Record<string, string>,
  body: string,
  filename: string,
  filenameVersion: number,
): LegalDocumentSeedSource {
  const known = new Set(['type', 'version', 'locale', 'title']);
  const unknown = Object.keys(meta).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    // `effective_at` and `is_active` are the usual mistakes here: publication
    // state is decided by the seed and the DB, never by a source file.
    throw new LegalSourceError(
      `${filename}: unsupported front matter key(s): ${unknown.join(', ')}. ` +
        'Only type, version, locale and title are read from source files — ' +
        'effectiveAt and isActive are publication state, owned by the seed.',
    );
  }

  const { type, version, locale, title } = meta;

  if (!type) throw new LegalSourceError(`${filename}: missing \`type\`.`);
  if (!isLegalDocumentType(type)) {
    throw new LegalSourceError(
      `${filename}: unknown \`type\` "${type}". Expected one of: ` +
        `${Object.keys(LegalDocumentType).join(', ')}.`,
    );
  }

  if (!version) throw new LegalSourceError(`${filename}: missing \`version\`.`);
  // Anchored: `1.0` and `1abc` are mistakes, not a version 1.
  if (!/^\d+$/.test(version)) {
    throw new LegalSourceError(
      `${filename}: \`version\` must be a positive integer, got "${version}".`,
    );
  }
  const parsedVersion = Number.parseInt(version, 10);
  if (parsedVersion < 1) {
    throw new LegalSourceError(
      `${filename}: \`version\` must be >= 1, got ${parsedVersion}.`,
    );
  }
  if (parsedVersion !== filenameVersion) {
    throw new LegalSourceError(
      `${filename}: filename says v${filenameVersion} but front matter says ` +
        `v${parsedVersion}. Rename the file or fix the front matter — which one ` +
        'is intended cannot be guessed.',
    );
  }

  if (!locale) throw new LegalSourceError(`${filename}: missing \`locale\`.`);
  if (!(LEGAL_LOCALES as readonly string[]).includes(locale)) {
    throw new LegalSourceError(
      `${filename}: unsupported \`locale\` "${locale}". Expected one of: ` +
        `${LEGAL_LOCALES.join(', ')}.`,
    );
  }
  const filenameLocale = filename.match(FILENAME_PATTERN)?.[3];
  if (filenameLocale !== locale) {
    throw new LegalSourceError(
      `${filename}: filename locale "${filenameLocale}" does not match front ` +
        `matter locale "${locale}".`,
    );
  }

  if (!title) throw new LegalSourceError(`${filename}: missing \`title\`.`);

  const content = body.trim();
  if (content === '') {
    throw new LegalSourceError(
      `${filename}: the markdown body is empty. A document with no text must ` +
        `not reach the database — use ${LEGAL_PLACEHOLDER_MARKER} if the final ` +
        'wording is not ready.',
    );
  }

  if (!content.includes(LEGAL_PLACEHOLDER_MARKER)) {
    const unresolved = UNRESOLVED_DRAFT_MARKERS.filter((marker) =>
      content.includes(marker),
    );
    if (unresolved.length > 0) {
      throw new LegalSourceError(
        `${filename}: still contains unresolved draft markers ` +
          `(${unresolved.join(', ')}). Close them — counsel sign-off and the ` +
          'company details from the registration documents — before seeding, ' +
          `or add ${LEGAL_PLACEHOLDER_MARKER} to mark the file as a draft. ` +
          'See docs/legal/00-PRE-PUBLICATION-CHECKLIST.md.',
      );
    }
  }

  return { type, version: parsedVersion, locale, title, content };
}

/**
 * Read and validate every legal source file.
 *
 * @param directory override for tests; defaults to the resolved `docs/legal`.
 * @param options.requireCompleteSet enforce one file per (type, locale) at the
 *   highest version. On by default so a missing translation fails the seed
 *   rather than quietly shipping two of three required documents; tests that
 *   build a partial fixture directory turn it off.
 */
export function loadLegalDocuments(
  directory: string = getLegalDocsDirectory(),
  options: { requireCompleteSet?: boolean } = {},
): LegalDocumentSeedSource[] {
  const { requireCompleteSet = true } = options;

  const entries = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort();

  const sources: LegalDocumentSeedSource[] = [];
  // Keyed by type|version|locale — the same identity as the DB's unique index.
  const seen = new Map<string, string>();

  for (const filename of entries) {
    const match = FILENAME_PATTERN.exec(filename);
    // Non-conforming names are companion docs (README, checklists), not sources.
    // Skipping them keeps the directory usable for humans; the completeness
    // check below is what guarantees nothing REQUIRED was skipped this way.
    if (!match) continue;

    const raw = fs.readFileSync(path.join(directory, filename), 'utf8');
    const { meta, body } = parseFrontMatter(raw, filename);
    const source = toSource(meta, body, filename, Number.parseInt(match[2], 10));

    const key = `${source.type}|${source.version}|${source.locale}`;
    const previous = seen.get(key);
    if (previous) {
      // Two differently-named files claiming one identity: the DB's unique index
      // would reject the second write, but reporting it here names both files.
      throw new LegalSourceError(
        `duplicate document ${source.type} v${source.version} (${source.locale}): ` +
          `both "${previous}" and "${filename}" declare it.`,
      );
    }
    seen.set(key, filename);
    sources.push(source);
  }

  if (sources.length === 0) {
    throw new LegalSourceError(
      `no legal source files found in ${directory}. Expected files named ` +
        '<document>.v<version>.<locale>.md',
    );
  }

  if (requireCompleteSet) assertCompleteSet(sources, directory);

  return sources;
}

/**
 * Every document type must exist in every locale, at the same highest version.
 *
 * The version check matters as much as the presence check: publishing
 * `privacy-policy.v2.ru.md` without the uz and en translations would leave a
 * user whose interface is Uzbek consenting to v1 while a Russian user consents
 * to v2 — one instrument, two populations, different wording.
 */
function assertCompleteSet(
  sources: LegalDocumentSeedSource[],
  directory: string,
): void {
  const highestByType = new Map<LegalDocumentType, number>();
  for (const source of sources) {
    const current = highestByType.get(source.type) ?? 0;
    if (source.version > current) highestByType.set(source.type, source.version);
  }

  const missing: string[] = [];
  for (const type of Object.keys(LegalDocumentType) as LegalDocumentType[]) {
    const highest = highestByType.get(type);
    if (highest === undefined) {
      missing.push(`${type}: no source file in any locale`);
      continue;
    }
    for (const locale of LEGAL_LOCALES) {
      const present = sources.some(
        (s) => s.type === type && s.locale === locale && s.version === highest,
      );
      if (!present) missing.push(`${type} v${highest} (${locale})`);
    }
  }

  if (missing.length > 0) {
    throw new LegalSourceError(
      `incomplete source set in ${directory} — missing:\n  ` +
        missing.join('\n  ') +
        '\nEvery required document must exist in every locale at its highest ' +
        'version, or some users would be asked to consent to a different ' +
        'version than others.',
    );
  }
}

/** Whether a stored document may be overwritten — i.e. holds no approved text. */
export function isPlaceholderLegalContent(
  content: string | null | undefined,
): boolean {
  const value = content?.trim();
  if (!value) return true;
  return value.includes(LEGAL_PLACEHOLDER_MARKER);
}
