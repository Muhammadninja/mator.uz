import { OEM_XREF_WAVE4_DATASET } from '../seed-data/oem-xref-wave4.dataset';
import type { XrefDataset } from './oem-xref.types';

/**
 * OEM cross-reference datasets the dry-run can be pointed at, by name. The CLI
 * requires one to be named; there is no default. A dataset must call itself by
 * its key here and say it is not retired, or the validator refuses it.
 */
export const OEM_XREF_DATASETS: Readonly<Record<string, XrefDataset>> = {
  'wave-4': OEM_XREF_WAVE4_DATASET,
};
