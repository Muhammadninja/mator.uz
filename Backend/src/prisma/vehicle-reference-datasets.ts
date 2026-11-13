import {
  WAVE1_HELD,
  WAVE1_KNOWN_ISSUES,
  WAVE1_MODELS,
} from './seed-data/vehicle-reference-wave1.seed';
import {
  WAVE2_HELD,
  WAVE2_KNOWN_ISSUES,
  WAVE2_MODELS,
} from './seed-data/vehicle-reference-wave2.seed';
import {
  ReferenceDataset,
  VEHICLE_REFERENCE_DATASET,
} from './vehicle-reference-plan';

/**
 * Datasets `seed:vehicle-reference` can run, by name. The CLI requires one to
 * be named, so no run picks a dataset by default.
 *
 * `g2` is the applied 2026-09-25 dataset, kept for the record. Re-running it
 * today is blocked by design: Ravon, SsangYong, Skoda and Genesis now exist
 * inactive, and it plans a Leapmotor deactivation.
 */
export const WAVE1_DATASET: ReferenceDataset = {
  label: 'Wave 1',
  // Owner decisions 2026-11-12: no make is created, activated or deactivated,
  // and every model needs an official source.
  policy: {
    allowNewMakes: false,
    allowMakeStateChanges: false,
    requireAvailabilitySources: true,
  },
  makes: [],
  models: WAVE1_MODELS,
  makeStateChanges: [],
  knownIssues: WAVE1_KNOWN_ISSUES,
  held: WAVE1_HELD,
};

/** Wave 2: inventory-driven, same policy as Wave 1. */
export const WAVE2_DATASET: ReferenceDataset = {
  label: 'Wave 2',
  policy: {
    allowNewMakes: false,
    allowMakeStateChanges: false,
    requireAvailabilitySources: true,
  },
  makes: [],
  models: WAVE2_MODELS,
  makeStateChanges: [],
  knownIssues: WAVE2_KNOWN_ISSUES,
  held: WAVE2_HELD,
};

export const REFERENCE_DATASETS: Record<string, ReferenceDataset> = {
  g2: VEHICLE_REFERENCE_DATASET,
  'wave-1': WAVE1_DATASET,
  'wave-2': WAVE2_DATASET,
};
