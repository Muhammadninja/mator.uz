/**
 * The snapshot `scripts/sql/catalog-identifier-snapshot.sql` prints, parsed
 * and checked. Pure: no I/O. Every number stays a string (leading zeros).
 */

export const AUDIT_SNAPSHOT_KIND = 'catalog-identifier-audit';
export const AUDIT_SNAPSHOT_FORMAT_VERSION = 1;

export class AuditSnapshotFormatError extends Error {
  override readonly name = 'AuditSnapshotFormatError';
}

export interface AuditPart {
  id: string;
  title: string;
  partBrandName: string | null;
  brandName: string | null;
  partNumberType: 'GM' | 'OEM' | 'UNKNOWN';
  gmNumbers: string[];
  oemNumbers: string[];
  isUniversal: boolean;
  /** ISO timestamp: the listing's default (newest-first) order. */
  createdAt: string;
  listed: boolean;
  hasFitment: boolean;
  /** The import's part-number cell as the file held it; null otherwise. */
  sourcePartNumber: string | null;
  /** The external system of an imported position (e.g. DRIVERS_VILLAGE). */
  sourceSystem: string | null;
}

export interface AuditSnapshot {
  capturedAt: string;
  database: string | null;
  parts: AuditPart[];
}

type Row = Record<string, unknown>;
const fail = (msg: string): never => {
  throw new AuditSnapshotFormatError(msg);
};

function str(row: Row, key: string, where: string): string {
  const v = row[key];
  return typeof v === 'string'
    ? v
    : fail(`${where}: "${key}" must be a string`);
}

function optStr(row: Row, key: string, where: string): string | null {
  return row[key] === null || row[key] === undefined
    ? null
    : str(row, key, where);
}

function bool(row: Row, key: string, where: string): boolean {
  const v = row[key];
  return typeof v === 'boolean'
    ? v
    : fail(`${where}: "${key}" must be true or false`);
}

function timestamp(row: Row, key: string, where: string): string {
  const v = str(row, key, where);
  return Number.isNaN(Date.parse(v))
    ? fail(`${where}: "${key}" must be an ISO timestamp`)
    : v;
}

function list(row: Row, key: string, where: string): string[] {
  const v = row[key];
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    // A number as a JSON number would already have lost its leading zeros.
    fail(`${where}: "${key}" must be an array of strings`);
  }
  return v as string[];
}

export function parseAuditSnapshot(text: string): AuditSnapshot {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    fail('not JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    fail('not a JSON object');
  const d = doc as Row;
  if (d.kind !== AUDIT_SNAPSHOT_KIND) {
    fail(
      `"kind" must be "${AUDIT_SNAPSHOT_KIND}" (got ${JSON.stringify(d.kind)})`,
    );
  }
  if (d.format_version !== AUDIT_SNAPSHOT_FORMAT_VERSION) {
    fail(`"format_version" must be ${AUDIT_SNAPSHOT_FORMAT_VERSION}`);
  }
  const capturedAt = str(d, 'captured_at', 'snapshot');
  const database = optStr(d, 'database', 'snapshot');
  if (!Array.isArray(d.parts)) fail('"parts" must be an array');
  const seen = new Set<string>();
  const parts = (d.parts as unknown[]).map((raw, i): AuditPart => {
    const where = `parts[${i}]`;
    if (!raw || typeof raw !== 'object') fail(`${where}: not an object`);
    const row = raw as Row;
    const id = str(row, 'id', where);
    if (!id) fail(`${where}: "id" is empty`);
    if (seen.has(id)) fail(`${where}: part id "${id}" appears twice`);
    seen.add(id);
    const type = row.part_number_type;
    if (type !== 'GM' && type !== 'OEM' && type !== 'UNKNOWN') {
      fail(`${where}: "part_number_type" must be GM, OEM or UNKNOWN`);
    }
    return {
      id,
      title: str(row, 'title', where),
      partBrandName: optStr(row, 'part_brand_name', where),
      brandName: optStr(row, 'brand_name', where),
      partNumberType: type as AuditPart['partNumberType'],
      gmNumbers: list(row, 'gm_numbers', where),
      oemNumbers: list(row, 'oem_numbers', where),
      isUniversal: bool(row, 'is_universal', where),
      createdAt: timestamp(row, 'created_at', where),
      listed: bool(row, 'listed', where),
      hasFitment: bool(row, 'has_fitment', where),
      sourcePartNumber: optStr(row, 'source_part_number', where),
      sourceSystem: optStr(row, 'source_system', where),
    };
  });
  return { capturedAt, database, parts };
}
