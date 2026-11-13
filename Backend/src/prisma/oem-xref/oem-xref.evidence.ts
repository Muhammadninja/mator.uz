import { normalizeOem } from '../../common/normalize-oem.util';
import {
  Collector,
  isObj,
  isoDateErrors,
  manufacturerKey,
  Obj,
  show,
  str,
  strictKeys,
} from './oem-xref.checks';
import { EVIDENCE_ASSERTIONS, EVIDENCE_TYPES } from './oem-xref.types';

/**
 * Provenance check of one source of a cross-reference record. Pure. A source
 * is admissible only when it is of an admissible type, names its document and
 * an exact locator, was read on a real past date, comes from the manufacturer
 * of one side (or a licensed catalog, with its licence), and cites BOTH of the
 * record's numbers in the record's direction.
 */

/**
 * Sources that are known NOT to be evidence: the demo rows in prisma/data
 * (12 rows, no provenance) wherever they are cited, and any file of this
 * repository named as a document.
 */
const DEMO_SOURCE = /oem-catalog(-skeleton)?\.csv/i;
const REPO_PATH = /^(\.{0,2}\/)?(Backend\/)?(prisma|src|scripts|test|docs)\//i;

const EVIDENCE_KEYS = [
  'type',
  'publisher',
  'documentId',
  'url',
  'locator',
  'retrievedOn',
  'licence',
  'cites',
  'asserts',
  'statement',
];

export function validateEvidence(
  c: Collector,
  v: unknown,
  where: string,
  rec: Obj,
  today: Date,
): void {
  if (!isObj(v))
    return c.add('provenance', 'bad_evidence', `${where} must be an object`);
  const before = c.issues.length;
  strictKeys(c, v, EVIDENCE_KEYS, where);
  // A malformed source is a provenance problem (the record stays visible to the
  // planner); vehicle data stays a structure error wherever it appears.
  for (const i of c.issues.slice(before))
    if (i.code !== 'fitment_not_allowed') i.category = 'provenance';

  const type = v.type;
  if (!EVIDENCE_TYPES.includes(type as never))
    c.add(
      'provenance',
      'inadmissible_source_type',
      `${where}.type "${show(type)}" is not admissible (${EVIDENCE_TYPES.join(', ')})`,
    );
  const publisher = str(v.publisher, 160);
  if (!publisher)
    c.add('provenance', 'no_publisher', `${where}.publisher is required`);
  const documentId = str(v.documentId, 200);
  if (!documentId)
    c.add(
      'provenance',
      'no_document_id',
      `${where}.documentId must identify the catalog or bulletin`,
    );
  if (v.url !== null) {
    let url: URL | null = null;
    try {
      url = typeof v.url === 'string' ? new URL(v.url) : null;
    } catch {
      url = null;
    }
    if (!url || url.protocol !== 'https:' || !url.hostname.includes('.'))
      c.add(
        'provenance',
        'bad_url',
        `${where}.url "${show(v.url)}" is not an https URL`,
      );
  }
  if (
    [documentId, v.url].some(
      (s) => typeof s === 'string' && DEMO_SOURCE.test(s),
    ) ||
    (documentId !== null && REPO_PATH.test(documentId))
  )
    c.add(
      'provenance',
      'untrusted_source',
      `${where} cites a file (e.g. prisma/data/oem-catalog.csv), not an official or licensed source`,
    );
  const locator = str(v.locator, 200);
  if (!locator || !/[0-9]/.test(locator))
    c.add(
      'provenance',
      'no_exact_locator',
      `${where}.locator "${show(v.locator ?? '')}" must point to an exact page / table / row (it has no number)`,
    );
  const dateErr = isoDateErrors(v.retrievedOn, today);
  if (dateErr)
    c.add('provenance', 'bad_retrieved_on', `${where}.retrievedOn ${dateErr}`);
  if (type === 'LICENSED_CATALOG' && !str(v.licence, 200))
    c.add(
      'provenance',
      'no_licence',
      `${where}: a licensed catalog needs its licence reference`,
    );
  if (!str(v.statement, 500))
    c.add(
      'provenance',
      'no_statement',
      `${where}.statement must say what exactly the source confirms`,
    );
  if (!EVIDENCE_ASSERTIONS.includes(v.asserts as never))
    c.add(
      'provenance',
      'bad_assertion',
      `${where}.asserts "${show(v.asserts)}" is not one of ${EVIDENCE_ASSERTIONS.join(', ')}`,
    );
  if (
    type === 'SUPERSESSION_BULLETIN' &&
    v.asserts !== 'SUPERSEDED_BY' &&
    v.asserts !== 'NO_RELATION'
  )
    c.add(
      'provenance',
      'bulletin_scope',
      `${where}: a supersession bulletin can only confirm SUPERSEDED_BY`,
    );

  // Official types must come from the manufacturer of one side.
  const from = isObj(rec.from) ? rec.from : {};
  const to = isObj(rec.to) ? rec.to : {};
  const sideKeys = [from.manufacturer, to.manufacturer]
    .filter((m): m is string => typeof m === 'string')
    .map(manufacturerKey);
  if (
    publisher &&
    (type === 'MANUFACTURER_CATALOG' || type === 'SUPERSESSION_BULLETIN') &&
    !sideKeys.includes(manufacturerKey(publisher))
  )
    c.add(
      'provenance',
      'not_official_source',
      `${where}: "${publisher}" is not the manufacturer of either side, so its ${type} is not official for this pair`,
    );

  // The source must cite both exact numbers, in the record's direction.
  const cites = v.cites;
  if (
    !isObj(cites) ||
    typeof cites.from !== 'string' ||
    typeof cites.to !== 'string'
  ) {
    c.add(
      'provenance',
      'no_cited_numbers',
      `${where}.cites must give both numbers as the source prints them`,
    );
    return;
  }
  const citedFrom = normalizeOem(cites.from);
  const citedTo = normalizeOem(cites.to);
  const fromN = typeof from.normalized === 'string' ? from.normalized : '';
  const toN = typeof to.normalized === 'string' ? to.normalized : '';
  if (citedFrom === fromN && citedTo === toN) return;
  if (citedFrom === toN && citedTo === fromN)
    c.add(
      'provenance',
      'evidence_direction_reversed',
      `${where}: the source cites "${cites.from}" → "${cites.to}", the reverse of the record`,
    );
  else
    c.add(
      'provenance',
      'evidence_cites_other_numbers',
      `${where}: the source cites "${cites.from}" / "${cites.to}", not this record's numbers`,
    );
}
