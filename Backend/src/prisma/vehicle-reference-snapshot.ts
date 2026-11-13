import type {
  ExistingMake,
  ExistingModel,
  ReferenceSnapshot,
} from './vehicle-reference-plan';

/**
 * Parse the JSON that `scripts/sql/vehicle-reference-snapshot.sql` prints, so
 * a dry-run can plan against a production snapshot without the seed ever
 * connecting to production. The file crosses a trust boundary (it is pasted
 * from a terminal), so every field is checked and anything unexpected fails.
 *
 * Shape (snake_case, as the SQL emits it):
 *   { "captured_at": "...", "makes": [{ id, name, is_active, coming_soon, sort_order }],
 *     "models": [{ id, make_id, name, sort_order, year_from, year_to, body_type,
 *                  variant_of_model_id }] }
 * `variant_of_model_id` may be absent (a database before migration
 * 20261115000000_vehicle_model_variants); absent means null.
 */

export class SnapshotFormatError extends Error {
  override readonly name = 'SnapshotFormatError';
}

export interface ParsedSnapshot {
  capturedAt: string | null;
  snapshot: ReferenceSnapshot;
}

type Row = Record<string, unknown>;

const fail = (msg: string): never => {
  throw new SnapshotFormatError(msg);
};

function text(row: Row, key: string, where: string): string {
  const v = row[key];
  return typeof v === 'string' && v.length > 0 && v.length <= 200
    ? v
    : fail(`${where}: "${key}" must be non-empty text`);
}

function int(row: Row, key: string, where: string): number {
  const v = row[key];
  return Number.isInteger(v)
    ? (v as number)
    : fail(`${where}: "${key}" must be an integer`);
}

function bool(row: Row, key: string, where: string): boolean {
  const v = row[key];
  return typeof v === 'boolean'
    ? v
    : fail(`${where}: "${key}" must be true/false`);
}

function nullableInt(row: Row, key: string, where: string): number | null {
  return row[key] === null ? null : int(row, key, where);
}

/** Admin free text: kept exactly as stored, even blank, never normalised. */
function nullableText(row: Row, key: string, where: string): string | null {
  const v = row[key];
  if (v === null) return null;
  return typeof v === 'string' && v.length <= 200
    ? v
    : fail(`${where}: "${key}" must be text or null`);
}

function rows(value: unknown, key: string): Row[] {
  if (!Array.isArray(value)) fail(`"${key}" must be an array`);
  return (value as unknown[]).map((r, i) =>
    r && typeof r === 'object' && !Array.isArray(r)
      ? (r as Row)
      : fail(`${key}[${i}] must be an object`),
  );
}

export function parseReferenceSnapshot(raw: string): ParsedSnapshot {
  let doc: unknown;
  try {
    doc = JSON.parse(raw.trim());
  } catch {
    fail('not valid JSON (run the snapshot SQL with psql -At)');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('expected one JSON object');
  }
  const top = doc as Row;

  const makes: ExistingMake[] = rows(top.makes, 'makes').map((r, i) => {
    const where = `makes[${i}]`;
    return {
      id: text(r, 'id', where),
      name: text(r, 'name', where),
      isActive: bool(r, 'is_active', where),
      comingSoon: bool(r, 'coming_soon', where),
      sortOrder: int(r, 'sort_order', where),
    };
  });
  const models: ExistingModel[] = rows(top.models, 'models').map((r, i) => {
    const where = `models[${i}]`;
    return {
      id: text(r, 'id', where),
      makeId: text(r, 'make_id', where),
      name: text(r, 'name', where),
      sortOrder: int(r, 'sort_order', where),
      yearFrom: nullableInt(r, 'year_from', where),
      yearTo: nullableInt(r, 'year_to', where),
      bodyType: nullableText(r, 'body_type', where),
      variantOfModelId:
        r.variant_of_model_id === undefined
          ? null
          : nullableText(r, 'variant_of_model_id', where),
    };
  });

  const dupes = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) fail(`${label} id "${id}" appears twice`);
      seen.add(id);
    }
  };
  dupes(
    'make',
    makes.map((m) => m.id),
  );
  dupes(
    'model',
    models.map((m) => m.id),
  );
  const makeIds = new Set(makes.map((m) => m.id));
  const modelIds = new Set(models.map((m) => m.id));
  for (const m of models) {
    if (m.variantOfModelId && !modelIds.has(m.variantOfModelId)) {
      fail(
        `model "${m.id}" is a variant of "${m.variantOfModelId}", which is not in the snapshot`,
      );
    }
    if (!makeIds.has(m.makeId)) {
      fail(
        `model "${m.id}" names make "${m.makeId}", which is not in the snapshot`,
      );
    }
  }
  if (makes.length === 0)
    fail('the snapshot has no makes; is it the right database?');

  const capturedAt =
    typeof top.captured_at === 'string' ? top.captured_at : null;
  return { capturedAt, snapshot: { makes, models } };
}
