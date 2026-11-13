import type { XrefIssue } from './oem-xref.types';

/** Helpers shared by the record and evidence validators. Pure. */

/** Uppercase letters and digits of a manufacturer name: `Hi-Q` → `HIQ`. */
export const manufacturerKey = (name: string): string =>
  name.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');

export const GM_KEY = 'GM';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A key that smells of vehicle data gets its own, louder refusal. */
export const FITMENT_KEY =
  /vehicle|fitment|make|model|universal|categor|trim|engine|year/i;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** A value for a message, never "[object Object]". */
export const show = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined ? 'undefined' : JSON.stringify(v);

export class Collector {
  readonly issues: XrefIssue[] = [];
  constructor(private readonly recordId: string | null) {}
  add(
    category: XrefIssue['category'],
    code: string,
    message: string,
    severity: XrefIssue['severity'] = 'error',
  ): void {
    this.issues.push({
      recordId: this.recordId,
      category,
      severity,
      code,
      message,
    });
  }
  get structureFailed(): boolean {
    return this.issues.some(
      (i) => i.category === 'structure' && i.severity === 'error',
    );
  }
}

export function strictKeys(
  c: Collector,
  obj: Obj,
  allowed: string[],
  where: string,
) {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    if (FITMENT_KEY.test(key))
      c.add(
        'structure',
        'fitment_not_allowed',
        `${where}: "${key}" looks like vehicle data — a cross-reference never carries fitment; vehicle compatibility is curated separately`,
      );
    else
      c.add('structure', 'unknown_field', `${where}: unknown field "${key}"`);
  }
  for (const key of allowed)
    if (!(key in obj))
      c.add('structure', 'missing_field', `${where}: "${key}" is missing`);
}

export function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max
    ? v
    : null;
}

export function isoDateErrors(value: unknown, today: Date): string | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value))
    return `"${show(value)}" is not a YYYY-MM-DD date`;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value)
    return `"${value}" is not a real date`;
  if (d.getTime() > today.getTime()) return `${value} is in the future`;
  return null;
}
