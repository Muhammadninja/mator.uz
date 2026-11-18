import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

/** Longest make or model name an owner may type (the column is VARCHAR(60)). */
export const MANUAL_NAME_MAX = 60;

/**
 * Where a new vehicle's make and model come from.
 *
 *   catalog  make_id + model_id from the reference catalog (the existing flow)
 *   manual   the catalog lacks the model: custom_model_name, with either a
 *            catalog make_id (the make is listed, the model is not) or a
 *            custom_make_name (neither is listed). Never a fabricated id.
 */
export type VehicleSource =
  | { kind: 'catalog'; makeId: string; modelId: string }
  | {
      kind: 'manual';
      makeId: string | null;
      customMakeName: string | null;
      customModelName: string;
    };

export interface VehicleSourceInput {
  make_id?: string;
  model_id?: string;
  custom_make_name?: string;
  custom_model_name?: string;
  trim_id?: string;
  engine_id?: string;
}

const invalid = (code: string, message: string, details?: Record<string, unknown>) =>
  new BadRequestException({ code, message, ...(details ? { details } : {}) });

// Control characters (C0, DEL, C1) and bidi overrides that could disguise a name.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * An owner-typed make or model name: Unicode-normalised, trimmed, inner runs of
 * whitespace collapsed, 1–60 characters with at least one letter or digit, and
 * no control or bidi-override characters. Throws VEHICLE_MANUAL_NAME_INVALID.
 */
export function normalizeVehicleName(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw invalid('VEHICLE_MANUAL_NAME_INVALID', `${field} must be text`, { field });
  }
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name || UNSAFE.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
    throw invalid('VEHICLE_MANUAL_NAME_INVALID', `${field} must contain a letter or digit`, { field });
  }
  if (name.length > MANUAL_NAME_MAX) {
    throw invalid('VEHICLE_MANUAL_NAME_INVALID', `${field} is longer than ${MANUAL_NAME_MAX} characters`, {
      field,
      max: MANUAL_NAME_MAX,
    });
  }
  return name;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * Decide catalog vs manual from the request, or throw VEHICLE_SOURCE_INVALID.
 * A request mixing the two (a model_id with a custom name, both a make_id and a
 * custom make, a trim or engine on a manual vehicle) is refused rather than
 * guessed, so a stored row always satisfies the database CHECK.
 */
export function parseVehicleSource(dto: VehicleSourceInput): VehicleSource {
  const manual = present(dto.custom_model_name) || present(dto.custom_make_name);
  if (!manual) {
    if (!present(dto.make_id) || !present(dto.model_id)) {
      throw invalid('VEHICLE_SOURCE_INVALID', 'make_id and model_id are required, or a custom_model_name');
    }
    return { kind: 'catalog', makeId: dto.make_id!, modelId: dto.model_id! };
  }
  if (present(dto.model_id)) {
    throw invalid('VEHICLE_SOURCE_INVALID', 'A manual vehicle has no model_id');
  }
  if (present(dto.trim_id) || present(dto.engine_id)) {
    throw invalid('VEHICLE_SOURCE_INVALID', 'A manual vehicle has no catalog trim or engine');
  }
  if (!present(dto.custom_model_name)) {
    throw invalid('VEHICLE_SOURCE_INVALID', 'custom_model_name is required for a manual vehicle');
  }
  if (present(dto.make_id) === present(dto.custom_make_name)) {
    throw invalid('VEHICLE_SOURCE_INVALID', 'Give either make_id or custom_make_name');
  }
  return {
    kind: 'manual',
    makeId: present(dto.make_id) ? dto.make_id! : null,
    customMakeName: present(dto.custom_make_name)
      ? normalizeVehicleName(dto.custom_make_name, 'custom_make_name')
      : null,
    customModelName: normalizeVehicleName(dto.custom_model_name, 'custom_model_name'),
  };
}

/** Case- and space-insensitive key for comparing a typed name with the catalog. */
export const nameKey = (name: string) => name.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');

const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Stable image-identity ids for a manual vehicle: `custom:<hash>` of the
 * normalised typed names (Cyrillic and Latin alike), so every owner who types
 * the same car shares one image request and one approved picture. A catalog
 * make keeps its own id. Never stored as vehicles.make_id/model_id.
 */
export function manualIdentityIds(input: {
  makeId: string | null;
  makeName: string;
  modelName: string;
}): { makeId: string; modelId: string } {
  const makeId = input.makeId ?? `custom:${shortHash(nameKey(input.makeName))}`;
  return { makeId, modelId: `custom:${shortHash(`${makeId}|${nameKey(input.modelName)}`)}` };
}
