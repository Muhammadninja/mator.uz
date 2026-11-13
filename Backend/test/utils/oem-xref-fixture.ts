import { normalizeOem } from '../../src/common/normalize-oem.util';
import type {
  CatalogPartSnapshot,
  CatalogSnapshot,
} from '../../src/prisma/oem-xref/oem-xref.catalog';
import {
  OEM_XREF_FORMAT_VERSION,
  XrefDataset,
  XrefEvidence,
  XrefRecord,
  XrefSide,
} from '../../src/prisma/oem-xref/oem-xref.types';

/**
 * Builders for the OEM cross-reference specs. Every number here is made up
 * (960000xx, ACME-…): fixtures, not data.
 */

export const TODAY = new Date('2026-11-13T12:00:00Z');

export const part = (
  id: string,
  numbers: { gm?: string[]; oem?: string[] } = {},
  brand: string | null = 'Acme',
): CatalogPartSnapshot => ({
  id,
  title: `Fixture part ${id}`,
  partBrandName: brand,
  partNumberType:
    numbers.gm?.length && !numbers.oem?.length
      ? 'GM'
      : numbers.oem?.length && !numbers.gm?.length
        ? 'OEM'
        : 'UNKNOWN',
  gmNumbers: numbers.gm ?? [],
  oemNumbers: numbers.oem ?? [],
});

export const snapshot = (parts: CatalogPartSnapshot[]): CatalogSnapshot => ({
  capturedAt: '2026-11-13T08:00:00Z',
  database: 'fixture',
  parts,
});

export const side = (
  catalogPartId: string,
  manufacturer: string,
  partNumber: string,
): XrefSide => ({
  catalogPartId,
  manufacturer,
  partNumber,
  normalized: normalizeOem(partNumber),
});

export const evidence = (
  from: string,
  to: string,
  overrides: Partial<XrefEvidence> = {},
): XrefEvidence => ({
  type: 'MANUFACTURER_CATALOG',
  publisher: 'GM',
  documentId: 'GM EPC fixture edition 2026-10',
  url: null,
  locator: 'p. 12, table 3, row 4',
  retrievedOn: '2026-11-01',
  licence: null,
  cites: { from, to },
  asserts: 'SAME_PART',
  statement: 'Fixture: the catalog lists both numbers as one part.',
  ...overrides,
});

export const record = (
  id: string,
  from: XrefSide,
  to: XrefSide,
  overrides: Partial<XrefRecord> = {},
): XrefRecord => ({
  id,
  status: 'CANDIDATE',
  relation: null,
  from,
  to,
  basis: 'REVIEWER_SUGGESTION',
  evidence: [],
  rejection: null,
  note: '',
  ...overrides,
});

export const dataset = (
  records: XrefRecord[],
  name = 'fixture',
): XrefDataset => ({
  formatVersion: OEM_XREF_FORMAT_VERSION,
  name,
  label: 'fixture',
  retired: false,
  records,
});

/** Freeze an object graph, so any write in code under test throws. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}
