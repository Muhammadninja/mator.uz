import {
  REFERENCE_MAKE_STATE_CHANGES,
  REFERENCE_NEW_MAKES,
  REFERENCE_NEW_MODELS,
  SeedMakeStateChange,
  SeedReferenceMake,
  SeedReferenceModel,
} from './seed-data/vehicle-reference.seed';

/**
 * Pure planning for the G-2 vehicle reference seed: given the dataset and one
 * read of the reference tables, decide what a run would create, what it leaves
 * alone and what blocks it. No database access here; the rules are described in
 * `vehicle-reference-seed.ts`, which runs the plan.
 */

export interface ReferenceDataset {
  makes: SeedReferenceMake[];
  models: SeedReferenceModel[];
  makeStateChanges: SeedMakeStateChange[];
}

export const VEHICLE_REFERENCE_DATASET: ReferenceDataset = {
  makes: REFERENCE_NEW_MAKES,
  models: REFERENCE_NEW_MODELS,
  makeStateChanges: REFERENCE_MAKE_STATE_CHANGES,
};

export interface ExistingMake {
  id: string;
  name: string;
  isActive: boolean;
  comingSoon: boolean;
  sortOrder: number;
}

export interface ExistingModel {
  id: string;
  makeId: string;
  name: string;
  sortOrder: number;
}

export interface ReferenceSnapshot {
  makes: ExistingMake[];
  models: ExistingModel[];
}

export interface PlannedMake {
  id: string;
  name: string;
  sortOrder: number;
  evidence: string;
}

export interface PlannedModel {
  id: string;
  makeId: string;
  name: string;
  sortOrder: number;
  evidence: string;
}

export interface PlannedStateChange {
  makeId: string;
  from: boolean;
  to: boolean;
  reason: string;
}

export interface ReferencePlan {
  /** Dataset rows already present exactly as the dataset describes them. */
  unchangedMakes: string[];
  unchangedModels: string[];
  newMakes: PlannedMake[];
  newModels: PlannedModel[];
  stateChanges: PlannedStateChange[];
  /** State changes already in effect (e.g. leapmotor already inactive). */
  stateUnchanged: string[];
  /** Existing data disagrees with the dataset; needs a manual migration. Blocking. */
  conflicts: string[];
  /** Invalid dataset, or an id another make owns. Blocking. */
  errors: string[];
  /** Existing rows the dataset does not mention; the seed never touches them. */
  untouched: { makes: number; models: number };
  /** Makes that already hold several models with the same name (informational). */
  duplicateNames: string[];
}

export const isBlocked = (plan: ReferencePlan): boolean =>
  plan.errors.length > 0 || plan.conflicts.length > 0;

/** Plans with nothing to write (a clean re-run). */
export const isNoop = (plan: ReferencePlan): boolean =>
  plan.newMakes.length === 0 &&
  plan.newModels.length === 0 &&
  plan.stateChanges.length === 0;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID = 64; // VarChar(64)
const MAX_NAME = 120; // VarChar(120)

/** Case-insensitive name key, matching how garage fitment compares names. */
const nameKey = (name: string): string => name.trim().toLowerCase();

function validateDataset(dataset: ReferenceDataset): string[] {
  const errors: string[] = [];
  const checkId = (label: string, id: string) => {
    if (!ID_PATTERN.test(id) || id.length > MAX_ID) {
      errors.push(
        `${label}: id "${id}" is not a lowercase slug of at most ${MAX_ID} chars`,
      );
    }
  };
  const checkName = (label: string, name: string) => {
    if (!name || name !== name.trim() || name.length > MAX_NAME) {
      errors.push(
        `${label}: name "${name}" is blank, padded or over ${MAX_NAME} chars`,
      );
    }
  };
  const dupes = (label: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key))
        errors.push(`${label} "${key}" appears twice in the dataset`);
      seen.add(key);
    }
  };

  for (const m of dataset.makes) {
    checkId(`make ${m.id}`, m.id);
    checkName(`make ${m.id}`, m.name);
  }
  for (const m of dataset.models) {
    checkId(`model ${m.id}`, m.id);
    checkName(`model ${m.id}`, m.name);
  }
  dupes(
    'make id',
    dataset.makes.map((m) => m.id),
  );
  dupes(
    'make name',
    dataset.makes.map((m) => nameKey(m.name)),
  );
  dupes(
    'model id',
    dataset.models.map((m) => m.id),
  );
  dupes(
    'model name',
    dataset.models.map((m) => `${m.makeId}/${nameKey(m.name)}`),
  );
  dupes(
    'make-state change for',
    dataset.makeStateChanges.map((c) => c.makeId),
  );
  for (const change of dataset.makeStateChanges) {
    if (dataset.makes.some((m) => m.id === change.makeId)) {
      errors.push(
        `make-state change for "${change.makeId}": that make is created by this dataset`,
      );
    }
  }
  return errors;
}

/** Pure: what a run would do to `snapshot`. Never touches the database. */
export function planVehicleReferenceSeed(
  dataset: ReferenceDataset,
  snapshot: ReferenceSnapshot,
): ReferencePlan {
  const plan: ReferencePlan = {
    unchangedMakes: [],
    unchangedModels: [],
    newMakes: [],
    newModels: [],
    stateChanges: [],
    stateUnchanged: [],
    conflicts: [],
    errors: validateDataset(dataset),
    untouched: { makes: 0, models: 0 },
    duplicateNames: [],
  };

  const makeById = new Map(snapshot.makes.map((m) => [m.id, m]));
  const modelById = new Map(snapshot.models.map((m) => [m.id, m]));

  // New rows go after everything already there (the admin console's rule).
  let nextMakeSort = Math.max(0, ...snapshot.makes.map((m) => m.sortOrder)) + 1;
  const nextModelSort = new Map<string, number>();
  const takeModelSort = (makeId: string) => {
    const existing = snapshot.models.filter((m) => m.makeId === makeId);
    const next =
      nextModelSort.get(makeId) ??
      Math.max(0, ...existing.map((m) => m.sortOrder)) + 1;
    nextModelSort.set(makeId, next + 1);
    return next;
  };

  for (const make of dataset.makes) {
    const existing = makeById.get(make.id);
    if (existing) {
      if (existing.name !== make.name) {
        plan.conflicts.push(
          `make "${make.id}" already exists as "${existing.name}", dataset says "${make.name}"; the seed does not rename it`,
        );
      } else if (!existing.isActive || existing.comingSoon) {
        plan.conflicts.push(
          `make "${make.id}" already exists but is ${existing.isActive ? 'coming soon' : 'inactive'}; the seed does not change its visibility`,
        );
      } else {
        plan.unchangedMakes.push(make.id);
      }
      continue;
    }
    const sameName = snapshot.makes.find(
      (m) => nameKey(m.name) === nameKey(make.name),
    );
    if (sameName) {
      plan.conflicts.push(
        `make "${make.name}" already exists as id "${sameName.id}"; creating "${make.id}" would duplicate it`,
      );
      continue;
    }
    plan.newMakes.push({
      id: make.id,
      name: make.name,
      sortOrder: nextMakeSort++,
      evidence: make.evidence,
    });
  }

  for (const model of dataset.models) {
    if (
      !makeById.has(model.makeId) &&
      !dataset.makes.some((m) => m.id === model.makeId)
    ) {
      plan.errors.push(
        `model "${model.id}": make "${model.makeId}" is neither in the database nor in the dataset`,
      );
      continue;
    }
    const existing = modelById.get(model.id);
    if (existing) {
      if (existing.makeId !== model.makeId) {
        plan.errors.push(
          `model id "${model.id}" already belongs to make "${existing.makeId}" ("${existing.name}"), not "${model.makeId}"`,
        );
      } else if (existing.name !== model.name) {
        plan.conflicts.push(
          `model "${model.id}" is named "${existing.name}", dataset says "${model.name}"; the seed does not rename it`,
        );
      } else {
        plan.unchangedModels.push(model.id);
      }
      continue;
    }
    const sameName = snapshot.models.find(
      (m) =>
        m.makeId === model.makeId && nameKey(m.name) === nameKey(model.name),
    );
    if (sameName) {
      plan.conflicts.push(
        `make "${model.makeId}" already has "${sameName.name}" as "${sameName.id}"; adding "${model.id}" would duplicate it`,
      );
      continue;
    }
    plan.newModels.push({
      id: model.id,
      makeId: model.makeId,
      name: model.name,
      sortOrder: takeModelSort(model.makeId),
      evidence: model.evidence,
    });
  }

  for (const change of dataset.makeStateChanges) {
    const make = makeById.get(change.makeId);
    if (!make) {
      plan.errors.push(
        `make-state change: make "${change.makeId}" does not exist`,
      );
      continue;
    }
    if (make.isActive === change.isActive) {
      plan.stateUnchanged.push(change.makeId);
      continue;
    }
    const modelCount =
      snapshot.models.filter((m) => m.makeId === change.makeId).length +
      plan.newModels.filter((m) => m.makeId === change.makeId).length;
    if (change.requireNoModels && modelCount > 0) {
      plan.conflicts.push(
        `make "${change.makeId}" now has ${modelCount} model(s); the planned is_active=${change.isActive} assumed none`,
      );
      continue;
    }
    plan.stateChanges.push({
      makeId: change.makeId,
      from: make.isActive,
      to: change.isActive,
      reason: change.reason,
    });
  }

  const datasetMakeIds = new Set([
    ...dataset.makes.map((m) => m.id),
    ...dataset.makeStateChanges.map((c) => c.makeId),
  ]);
  const datasetModelIds = new Set(dataset.models.map((m) => m.id));
  plan.untouched = {
    makes: snapshot.makes.filter((m) => !datasetMakeIds.has(m.id)).length,
    models: snapshot.models.filter((m) => !datasetModelIds.has(m.id)).length,
  };

  const byName = new Map<string, ExistingModel[]>();
  for (const m of snapshot.models) {
    const key = `${m.makeId}/${nameKey(m.name)}`;
    byName.set(key, [...(byName.get(key) ?? []), m]);
  }
  for (const group of byName.values()) {
    if (group.length > 1) {
      plan.duplicateNames.push(
        `${group[0].makeId}: "${group[0].name}" → ${group.map((m) => m.id).join(', ')}`,
      );
    }
  }
  return plan;
}
