/**
 * Maps Driver's Village 1C vehicle codes (vehicle_make = CHEVROLET,
 * vehicle_model = DAMAS-2) onto the canonical make/model names the rest of
 * Mator uses — the names persisted in brands / car_models and projected into
 * catalog_part_fits, which the buyer app filters on.
 *
 * Resolution is deterministic and never fuzzy:
 *   1. the explicit 1C code table below (generation-suffixed codes and names
 *      the canonical catalog does not carry), then
 *   2. an EXACT alias match in VEHICLE_CATALOG for the resolved make, after the
 *      one normalization 1C codes need: '-' → ' ' ("NEXIA-3" → "nexia 3").
 * Anything else is unresolved and reported — never guessed.
 *
 * Every table entry is a reviewed business decision. In particular a
 * generation code (DAMAS-2, DAMAS-3-MOVE, MALIBU-2, CAPTIVA-5, TRACKER-1)
 * collapses into its base model, because the buyer catalog has no generation
 * level; the dry-run lists every mapping so it can be checked.
 */
import { VEHICLE_CATALOG } from '../../ai/vehicle-catalog';

/** Makes the canonical catalog does not carry, by 1C code. */
const EXTRA_MAKES: Readonly<Record<string, string>> = {
  SSANGYONG: 'SsangYong',
  GENESIS: 'Genesis',
};

/** Explicit model codes, keyed `${canonicalMake}|${MODEL_CODE}`. */
const MODEL_CODE_TABLE: Readonly<Record<string, string>> = {
  // Generation codes → base model (the buyer catalog has no generation level).
  'Chevrolet|DAMAS-2': 'Damas',
  'Chevrolet|DAMAS-3-MOVE': 'Damas',
  'Chevrolet|MALIBU-2': 'Malibu',
  'Chevrolet|MALIBU-1,5-TURBO': 'Malibu',
  'Chevrolet|CAPTIVA-5': 'Captiva',
  'Chevrolet|TRACKER-1': 'Tracker',
  // Chevrolet-badged models the canonical catalog does not list under Chevrolet.
  'Chevrolet|NEXIA-1': 'Nexia 1',
  'Chevrolet|EPICA': 'Epica',
  'Chevrolet|TACUMA': 'Tacuma',
  // Makes outside the canonical catalog.
  'SsangYong|REXTON': 'Rexton',
  'SsangYong|TORRES': 'Torres',
  'SsangYong|KORANDO': 'Korando',
  'SsangYong|MUSSO': 'Musso',
  'Genesis|G90': 'G90',
};

export interface ResolvedMake {
  make: string;
  via: 'alias' | 'table';
  inCanonicalCatalog: boolean;
}

export interface ResolvedModel {
  model: string;
  via: 'alias' | 'table';
  inCanonicalCatalog: boolean;
}

/** Uppercase + trim + collapse inner whitespace: the 1C code key form. */
export function normalizeVehicleCode(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Resolve a 1C make code, or null when it names no known make. */
export function resolveMake(rawCode: string): ResolvedMake | null {
  const code = normalizeVehicleCode(rawCode);
  if (!code) return null;
  const key = code.toLowerCase();
  const matches = VEHICLE_CATALOG.filter(
    (b) => b.canonical.toLowerCase() === key || b.aliases.includes(key),
  );
  if (matches.length === 1) {
    return {
      make: matches[0].canonical,
      via: 'alias',
      inCanonicalCatalog: true,
    };
  }
  if (matches.length > 1) return null; // ambiguous alias — never pick one
  const extra = EXTRA_MAKES[code];
  return extra
    ? { make: extra, via: 'table', inCanonicalCatalog: false }
    : null;
}

/** Resolve a 1C model code under an already-resolved canonical make. */
export function resolveModel(
  canonicalMake: string,
  rawCode: string,
): ResolvedModel | null {
  const code = normalizeVehicleCode(rawCode);
  if (!code) return null;

  const brand = VEHICLE_CATALOG.find((b) => b.canonical === canonicalMake);
  const inCanon = (model: string) =>
    !!brand?.models.some((m) => m.canonical === model);

  const tabled = MODEL_CODE_TABLE[`${canonicalMake}|${code}`];
  if (tabled) {
    return { model: tabled, via: 'table', inCanonicalCatalog: inCanon(tabled) };
  }

  if (!brand) return null;
  const key = code.toLowerCase().replace(/-/g, ' ');
  const matches = brand.models.filter(
    (m) => m.canonical.toLowerCase() === key || m.aliases.includes(key),
  );
  if (matches.length !== 1) return null; // none, or an ambiguous alias
  return {
    model: matches[0].canonical,
    via: 'alias',
    inCanonicalCatalog: true,
  };
}
