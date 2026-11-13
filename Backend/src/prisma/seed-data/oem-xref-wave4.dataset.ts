import {
  OEM_XREF_FORMAT_VERSION,
  XrefDataset,
} from '../oem-xref/oem-xref.types';

/**
 * Wave 4 trusted OEM cross-reference dataset (2026-11-13).
 *
 * EMPTY BY DESIGN. The repository holds no admissible source: no manufacturer
 * catalog, no supersession bulletin and no licensed catalog extract. The only
 * cross-code data in the repository, the 12 rows of prisma/data/oem-catalog.csv
 * (which put OEM and aftermarket codes in one cell, e.g. 95939923|SP1362), is
 * demo data without provenance and is deliberately NOT carried over — not even
 * as candidates (the validator refuses it as a source).
 *
 * Pairs of listings sharing an exact GM number are found from the catalog
 * snapshot at dry-run time (oem-xref.catalog.ts), not stored here. A reviewer
 * adds a record only to queue (CANDIDATE), confirm (VERIFIED, with a source
 * that cites both numbers and an exact locator) or refuse (REJECTED, with a
 * reason) a specific pair. See oem-xref.types.ts for the format.
 */
export const OEM_XREF_WAVE4_DATASET: XrefDataset = {
  formatVersion: OEM_XREF_FORMAT_VERSION,
  name: 'wave-4',
  label: 'Wave 4 OEM cross-reference (no admissible source yet)',
  retired: false,
  records: [],
};
