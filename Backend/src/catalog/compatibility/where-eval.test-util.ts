/**
 * TEST-ONLY: evaluate a Prisma `where` object against an in-memory record.
 *
 * The catalog compatibility filters are Prisma predicates; asserting their
 * SHAPE proves nothing about which parts a Cobalt owner actually sees. This
 * evaluator runs the predicate over fixture rows so a test can assert the
 * RESULT ("Cobalt sees X, Spark does not"). It implements only the subset the
 * catalog filters use — AND / OR / NOT, to-many `some` / `none`, to-one
 * nested filters, `equals` (+ `mode: 'insensitive'`), `in`, `has`, `not`, and
 * plain equality — and throws on anything else, so an unsupported operator
 * fails loudly instead of silently matching.
 *
 * It is NOT a substitute for PostgreSQL: it proves the predicate's logic, not
 * the SQL Prisma generates for it.
 */

type Rec = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Rec =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Date);

function matchScalar(actual: unknown, filter: unknown): boolean {
  if (!isPlainObject(filter)) return actual === filter;
  const insensitive = filter.mode === 'insensitive';
  const norm = (x: unknown) =>
    insensitive && typeof x === 'string' ? x.toLowerCase() : x;
  for (const [op, expected] of Object.entries(filter)) {
    switch (op) {
      case 'mode':
        break;
      case 'equals':
        if (norm(actual) !== norm(expected)) return false;
        break;
      case 'in':
        if (!(expected as unknown[]).map(norm).includes(norm(actual)))
          return false;
        break;
      case 'not':
        if (
          isPlainObject(expected)
            ? matchScalar(actual, expected)
            : actual === expected
        )
          return false;
        break;
      case 'has':
        if (!Array.isArray(actual) || !actual.includes(expected)) return false;
        break;
      default:
        throw new Error(`where-eval: unsupported scalar operator "${op}"`);
    }
  }
  return true;
}

export function matchesWhere(record: Rec, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  if (!isPlainObject(where))
    throw new Error('where-eval: where must be an object');

  for (const [key, filter] of Object.entries(where)) {
    if (key === 'AND') {
      const list = Array.isArray(filter) ? filter : [filter];
      if (!list.every((w) => matchesWhere(record, w))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(filter as unknown[]).some((w) => matchesWhere(record, w)))
        return false;
      continue;
    }
    if (key === 'NOT') {
      const list = Array.isArray(filter) ? filter : [filter];
      if (list.some((w) => matchesWhere(record, w))) return false;
      continue;
    }

    const value = record[key];
    if (
      Array.isArray(value) &&
      isPlainObject(filter) &&
      ('some' in filter || 'none' in filter || 'every' in filter)
    ) {
      const rows = value as Rec[];
      if ('some' in filter && !rows.some((r) => matchesWhere(r, filter.some)))
        return false;
      if ('none' in filter && rows.some((r) => matchesWhere(r, filter.none)))
        return false;
      if (
        'every' in filter &&
        !rows.every((r) => matchesWhere(r, filter.every))
      )
        return false;
      continue;
    }
    if (isPlainObject(value) && isPlainObject(filter)) {
      // To-one relation: a nested where over the related record.
      if (!matchesWhere(value, filter)) return false;
      continue;
    }
    if (!matchScalar(value, filter)) return false;
  }
  return true;
}

/** The ids of the fixture rows a `where` selects, in fixture order. */
export function selectIds(rows: Rec[], where: unknown): string[] {
  return rows.filter((r) => matchesWhere(r, where)).map((r) => r.id as string);
}
