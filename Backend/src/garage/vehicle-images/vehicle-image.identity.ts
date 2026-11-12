import { createHash } from 'node:crypto';

/**
 * Canonical vehicle identity for the Vehicle Image Pipeline.
 *
 * Source of truth: MatorUI- `services/vehicle-image-pipeline.mjs` at commit
 * 567bdfc0ae89ead383f23b6a0731b1de09e61f08 (Phase 3D). The pipeline validates the
 * identity, builds the ordered tuple and hashes it with SHA-256; it hashes what IT
 * validated, so the rules below are a faithful port. Each check is the
 * pipeline's own (field set, catalog-ID pattern, length, control characters,
 * year range, trimming). If they diverge, the pipeline's `identityKey` in its
 * response no longer matches ours, and the client refuses the response.
 *
 * Identity tuple (JSON array, hashed as `JSON.stringify(tuple)`):
 *   ['mator-vehicle-image-v1', makeId, modelId, modelYear,
 *    generationId, faceliftId, bodyType, trimId]
 */
export const CANONICAL_IDENTITY_VERSION = 'mator-vehicle-image-v1';

export interface CanonicalVehicleIdentity {
  makeId: string;
  modelId: string;
  modelYear: number;
  generationId: string | null;
  faceliftId: string | null;
  bodyType: string | null;
  trimId: string | null;
}

/** Display facts sent with a request. `trim` only together with `trimId`. */
export interface VehicleImageDisplay {
  manufacturer: string;
  model: string;
  trim?: string;
}

export class IdentityContractError extends Error {
  override readonly name = 'IdentityContractError';
}

// The pipeline's own control-character check, verbatim.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDENTITY_FIELDS = [
  'makeId',
  'modelId',
  'modelYear',
  'generationId',
  'faceliftId',
  'bodyType',
  'trimId',
] as const;

function canonicalText(value: unknown, name: string, maxLength = 64): string {
  if (typeof value !== 'string')
    throw new IdentityContractError(`${name} must be text`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    CONTROL_CHARS.test(normalized)
  ) {
    throw new IdentityContractError(`${name} is invalid`);
  }
  return normalized;
}

function canonicalCatalogId(value: unknown, name: string): string {
  const normalized = canonicalText(value, name);
  if (!CATALOG_ID.test(normalized)) {
    throw new IdentityContractError(`${name} must be a canonical catalog ID`);
  }
  return normalized;
}

function optionalCatalogId(value: unknown, name: string): string | null {
  return value === null ? null : canonicalCatalogId(value, name);
}

/** Port of the pipeline's `validateCanonicalVehicleIdentity`. */
export function validateCanonicalIdentity(
  value: unknown,
): CanonicalVehicleIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityContractError('canonical identity is required');
  }
  const record = value as Record<string, unknown>;
  const fields: readonly string[] = IDENTITY_FIELDS;
  if (Object.keys(record).some((field) => !fields.includes(field))) {
    throw new IdentityContractError(
      'canonical identity contains unsupported fields',
    );
  }
  if (fields.some((field) => !Object.hasOwn(record, field))) {
    throw new IdentityContractError(
      'canonical identity must include every ordered identity field',
    );
  }
  const year = record.modelYear;
  if (
    !Number.isInteger(year) ||
    (year as number) < 1886 ||
    (year as number) > 2200
  ) {
    throw new IdentityContractError('modelYear must be a valid model year');
  }
  return {
    makeId: canonicalCatalogId(record.makeId, 'makeId'),
    modelId: canonicalCatalogId(record.modelId, 'modelId'),
    modelYear: year as number,
    generationId: optionalCatalogId(record.generationId, 'generationId'),
    faceliftId: optionalCatalogId(record.faceliftId, 'faceliftId'),
    bodyType:
      record.bodyType === null
        ? null
        : canonicalText(record.bodyType, 'bodyType', 60),
    trimId: optionalCatalogId(record.trimId, 'trimId'),
  };
}

export function canonicalIdentityTuple(
  identity: CanonicalVehicleIdentity,
): unknown[] {
  const v = validateCanonicalIdentity(identity);
  return [
    CANONICAL_IDENTITY_VERSION,
    v.makeId,
    v.modelId,
    v.modelYear,
    v.generationId,
    v.faceliftId,
    v.bodyType,
    v.trimId,
  ];
}

/** SHA-256 hex of the JSON-serialised tuple: the pipeline's `identityKey`. */
export function canonicalIdentityKey(
  identity: CanonicalVehicleIdentity,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalIdentityTuple(identity)))
    .digest('hex');
}

/** Port of the pipeline's display validation (labels ≤120 chars, label iff id). */
export function validateDisplay(
  display: VehicleImageDisplay,
  identity: CanonicalVehicleIdentity,
): VehicleImageDisplay {
  const manufacturer = canonicalText(
    display.manufacturer,
    'vehicle.manufacturer',
    120,
  );
  const model = canonicalText(display.model, 'vehicle.model', 120);
  const trim =
    display.trim == null
      ? null
      : canonicalText(display.trim, 'vehicle.trim', 120);
  if ((identity.trimId === null) !== (trim === null)) {
    throw new IdentityContractError(
      'vehicle.trim must be supplied only with its canonical ID',
    );
  }
  // Generation and facelift are never sent (we never have their canonical IDs).
  if (identity.generationId !== null || identity.faceliftId !== null) {
    throw new IdentityContractError(
      'generation/facelift labels are not available',
    );
  }
  return trim === null
    ? { manufacturer, model }
    : { manufacturer, model, trim };
}

/** The pipeline's name normalisation (trim, en-US lowercase, collapse spaces). */
export function normalizeName(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ');
}

// ── Garage → identity ─────────────────────────────────────────────────────────

/** Why a vehicle stays on the placeholder and is flagged for review. */
export const IMAGE_REVIEW_REASONS = {
  /** Another model of the same make has the same display name (e.g. `tracker` / `tracker-2`). */
  DUPLICATE_MODEL_NAME: 'duplicate_model_name',
  /** The catalog states a production range for the model and the year is outside it. */
  YEAR_OUTSIDE_MODEL_RANGE: 'year_outside_model_range',
  /** A catalog row is missing or does not satisfy the pipeline's identity contract. */
  IDENTITY_INVALID: 'identity_invalid',
} as const;
export type ImageReviewReason =
  (typeof IMAGE_REVIEW_REASONS)[keyof typeof IMAGE_REVIEW_REASONS];

/** Catalog rows the identity is built from: all read from existing catalog tables. */
export interface VehicleIdentitySource {
  year: number;
  make: { id: string; name: string } | null;
  model: {
    id: string;
    makeId: string;
    name: string;
    bodyType: string | null;
    yearFrom: number | null;
    yearTo: number | null;
  } | null;
  /** The trim the owner picked from the catalog, already checked to belong to the model. */
  trim: { id: string; modelId: string; name: string } | null;
  /** Display names of the make's OTHER models. */
  siblingModelNames: string[];
}

export type IdentityPlan =
  | {
      kind: 'request';
      identity: CanonicalVehicleIdentity;
      display: VehicleImageDisplay;
      identityKey: string;
    }
  | { kind: 'review'; reason: ImageReviewReason };

/**
 * Build the canonical identity from catalog rows only.
 *
 * Authoritative fields only: make, model and year from the Garage record; body
 * type from the catalog model row when set; trim only when the owner picked a
 * catalog trim. Generation and facelift are always null. The catalog has no
 * generation or facelift table, and nothing here derives them from a trim id,
 * a year or a name. Colour, engine, VIN and plate never enter the identity.
 *
 * When the vehicle could not be told apart from another by these facts, or the
 * catalog contradicts it, returns `review`. The vehicle keeps the placeholder
 * and nothing is sent to the pipeline.
 */
export function planVehicleIdentity(src: VehicleIdentitySource): IdentityPlan {
  const review = (reason: ImageReviewReason): IdentityPlan => ({
    kind: 'review',
    reason,
  });
  const { make, model, trim } = src;
  if (!make || !model || model.makeId !== make.id)
    return review(IMAGE_REVIEW_REASONS.IDENTITY_INVALID);
  if (trim && trim.modelId !== model.id)
    return review(IMAGE_REVIEW_REASONS.IDENTITY_INVALID);

  const ownName = normalizeName(model.name);
  if (src.siblingModelNames.some((name) => normalizeName(name) === ownName)) {
    return review(IMAGE_REVIEW_REASONS.DUPLICATE_MODEL_NAME);
  }
  if (
    (model.yearFrom != null && src.year < model.yearFrom) ||
    (model.yearTo != null && src.year > model.yearTo)
  ) {
    return review(IMAGE_REVIEW_REASONS.YEAR_OUTSIDE_MODEL_RANGE);
  }

  const bodyType = model.bodyType?.trim() ? model.bodyType : null;
  try {
    const identity = validateCanonicalIdentity({
      makeId: make.id,
      modelId: model.id,
      modelYear: src.year,
      generationId: null,
      faceliftId: null,
      bodyType,
      trimId: trim ? trim.id : null,
    });
    const display = validateDisplay(
      trim
        ? { manufacturer: make.name, model: model.name, trim: trim.name }
        : { manufacturer: make.name, model: model.name },
      identity,
    );
    return {
      kind: 'request',
      identity,
      display,
      identityKey: canonicalIdentityKey(identity),
    };
  } catch (err) {
    if (err instanceof IdentityContractError)
      return review(IMAGE_REVIEW_REASONS.IDENTITY_INVALID);
    throw err;
  }
}
