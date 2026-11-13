import { VEHICLE_IMAGE_CATALOG_SOURCE } from './vehicle-image-catalog.data';

/**
 * Rules over the owner-approved vehicle image registry
 * (vehicle-image-catalog.data.ts), ported from the Vehicle Image Pipeline
 * (MatorUI- `services/vehicle-image-pipeline.mjs`, `identityMatchesCatalogMapping`
 * and `matchingCatalogAssets`) so the Garage can answer without the pipeline.
 *
 * Two questions, both from registry entries only, never from a name, a VIN, a
 * registration region or a global default:
 *
 *   - Which market, generation and facelift is this vehicle? Only entries whose
 *     identity is verified (`identityVerified`) and that state a market answer it,
 *     through a model mapping covering the vehicle's catalog model and year.
 *   - Which approved image shows it? An approved entry of the same make and market
 *     whose FIRST mapping covers the vehicle is an exact match; one whose later
 *     (alias) mapping covers it is a verified compatible match. Exactly one match
 *     at a tier, or none. Two at the same tier is ambiguous.
 *
 * Years in the registry are build (production) years, like the Garage `year` and
 * the catalog's `year_from`/`year_to`.
 */

export interface CatalogModelMapping {
  modelId: string;
  yearFrom: number;
  yearTo: number;
  generationId?: string;
  faceliftId?: string;
  trimPrefixes?: string[];
}

export interface CatalogAsset {
  id: string;
  makeId: string | null;
  modelMappings: CatalogModelMapping[];
  generationId: string | null;
  faceliftId: string | null;
  marketRegion: string | null;
  identityVerified: boolean;
  generationVerified: boolean;
  approvalStatus: 'approved' | 'pending' | 'rejected';
  assetKey: string | null;
}

/** The vehicle as the registry sees it: catalog ids and the build year only. */
export interface CatalogVehicle {
  makeId: string;
  /** The catalog row the vehicle is pictured as (`nexia-3`, not `nexia`, once resolved). */
  modelId: string;
  year: number;
  trimId: string | null;
}

export type CatalogIdentityFacts =
  | {
      status: 'verified';
      marketRegion: string;
      generationId: string | null;
      faceliftId: string | null;
    }
  /** No verified entry covers the vehicle: its market (and body) is unknown. */
  | { status: 'unverified' }
  /** Verified entries disagree on market, generation or facelift. */
  | { status: 'ambiguous' }
  /** A covering entry's image was rejected by the owner. */
  | { status: 'rejected' };

export interface CatalogAssetMatch {
  assetKey: string;
  match: 'exact' | 'compatible';
}

const ASSET_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKET = /^[A-Z]{2}$/;
const APPROVALS = new Set(['approved', 'pending', 'rejected']);

function fail(message: string): never {
  throw new Error(`vehicle image registry is invalid: ${message}`);
}

const optionalText = (value: unknown, name: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be text`);
  return value;
};

function parseMapping(raw: unknown, where: string): CatalogModelMapping {
  if (!raw || typeof raw !== 'object')
    fail(`${where} mapping is not an object`);
  const m = raw as Record<string, unknown>;
  if (typeof m.modelId !== 'string' || !m.modelId) fail(`${where} modelId`);
  if (
    !Number.isInteger(m.yearFrom) ||
    !Number.isInteger(m.yearTo) ||
    (m.yearFrom as number) > (m.yearTo as number)
  )
    fail(`${where} year range`);
  const prefixes = m.trimPrefixes;
  if (
    prefixes !== undefined &&
    (!Array.isArray(prefixes) ||
      prefixes.some((p) => typeof p !== 'string' || !p))
  )
    fail(`${where} trimPrefixes`);
  return {
    modelId: m.modelId,
    yearFrom: m.yearFrom as number,
    yearTo: m.yearTo as number,
    ...(typeof m.generationId === 'string'
      ? { generationId: m.generationId }
      : {}),
    ...(typeof m.faceliftId === 'string' ? { faceliftId: m.faceliftId } : {}),
    ...(prefixes ? { trimPrefixes: prefixes as string[] } : {}),
  };
}

/** Strict parse: a malformed registry is a build defect and fails loudly. */
export function parseVehicleImageCatalog(raw: unknown): CatalogAsset[] {
  if (!raw || typeof raw !== 'object') fail('not an object');
  const assets = (raw as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) fail('assets is not a list');
  const ids = new Set<string>();
  return assets.map((entry: unknown, i): CatalogAsset => {
    if (!entry || typeof entry !== 'object') fail(`asset ${i}`);
    const a = entry as Record<string, unknown>;
    const id = typeof a.id === 'string' && a.id ? a.id : fail(`asset ${i} id`);
    if (ids.has(id)) fail(`duplicate asset id ${id}`);
    ids.add(id);
    if (!Array.isArray(a.modelMappings)) fail(`${id} modelMappings`);
    if (!APPROVALS.has(a.approvalStatus as string))
      fail(`${id} approvalStatus`);
    const marketRegion = optionalText(a.marketRegion, `${id} marketRegion`);
    if (marketRegion !== null && !MARKET.test(marketRegion))
      fail(`${id} marketRegion`);
    const assetKey = optionalText(a.assetKey, `${id} assetKey`);
    if (assetKey !== null && !ASSET_KEY.test(assetKey)) fail(`${id} assetKey`);
    if (
      typeof a.identityVerified !== 'boolean' ||
      typeof a.generationVerified !== 'boolean'
    )
      fail(`${id} verification flags`);
    return {
      id,
      makeId: optionalText(a.makeId, `${id} makeId`),
      modelMappings: a.modelMappings.map((m: unknown) => parseMapping(m, id)),
      generationId: optionalText(a.generationId, `${id} generationId`),
      faceliftId: optionalText(a.faceliftId, `${id} faceliftId`),
      marketRegion,
      identityVerified: a.identityVerified,
      generationVerified: a.generationVerified,
      approvalStatus: a.approvalStatus as CatalogAsset['approvalStatus'],
      assetKey,
    };
  });
}

export const VEHICLE_IMAGE_CATALOG: readonly CatalogAsset[] =
  parseVehicleImageCatalog(JSON.parse(VEHICLE_IMAGE_CATALOG_SOURCE));

/**
 * Port of the pipeline's `identityMatchesCatalogMapping`. The Garage never sends a
 * generation or facelift id, so a mapping that requires one never matches.
 */
function mappingCovers(m: CatalogModelMapping, v: CatalogVehicle): boolean {
  if (m.modelId !== v.modelId) return false;
  if (v.year < m.yearFrom || v.year > m.yearTo) return false;
  if (m.generationId || m.faceliftId) return false;
  if (m.trimPrefixes?.length)
    return m.trimPrefixes.some((p) => v.trimId?.startsWith(p) ?? false);
  return true;
}

const covers = (a: CatalogAsset, v: CatalogVehicle): boolean =>
  a.makeId === v.makeId && a.modelMappings.some((m) => mappingCovers(m, v));

/** Market, generation and facelift of a vehicle, from verified entries only. */
export function catalogIdentityFacts(
  v: CatalogVehicle,
  catalog: readonly CatalogAsset[] = VEHICLE_IMAGE_CATALOG,
): CatalogIdentityFacts {
  const entries = catalog.filter(
    (a) => a.identityVerified && a.marketRegion !== null && covers(a, v),
  );
  if (entries.length === 0) return { status: 'unverified' };
  if (entries.some((a) => a.approvalStatus === 'rejected'))
    return { status: 'rejected' };
  const distinct = (values: (string | null)[]) =>
    new Set(values.filter((x): x is string => x !== null));
  const markets = distinct(entries.map((a) => a.marketRegion));
  const verified = entries.filter((a) => a.generationVerified);
  const generations = distinct(verified.map((a) => a.generationId));
  const facelifts = distinct(verified.map((a) => a.faceliftId));
  if (markets.size !== 1 || generations.size > 1 || facelifts.size > 1)
    return { status: 'ambiguous' };
  return {
    status: 'verified',
    marketRegion: [...markets][0],
    generationId: [...generations][0] ?? null,
    faceliftId: [...facelifts][0] ?? null,
  };
}

/**
 * The approved image for a vehicle of a verified market: exact first, then a
 * verified compatible (alias) mapping; null when none; 'ambiguous' when two
 * entries answer at the same tier.
 */
export function approvedCatalogAsset(
  v: CatalogVehicle & { marketRegion: string },
  catalog: readonly CatalogAsset[] = VEHICLE_IMAGE_CATALOG,
): CatalogAssetMatch | null | 'ambiguous' {
  const approved = catalog.filter(
    (a): a is CatalogAsset & { assetKey: string } =>
      a.approvalStatus === 'approved' &&
      a.identityVerified &&
      a.assetKey !== null &&
      a.makeId === v.makeId &&
      a.marketRegion === v.marketRegion,
  );
  const exact = approved.filter(
    (a) => a.modelMappings.length > 0 && mappingCovers(a.modelMappings[0], v),
  );
  if (exact.length > 1) return 'ambiguous';
  if (exact.length === 1)
    return { assetKey: exact[0].assetKey, match: 'exact' };
  const compatible = approved.filter((a) =>
    a.modelMappings.slice(1).some((m) => mappingCovers(m, v)),
  );
  if (compatible.length > 1) return 'ambiguous';
  if (compatible.length === 1)
    return { assetKey: compatible[0].assetKey, match: 'compatible' };
  return null;
}

const APPROVED_KEYS: ReadonlySet<string> = new Set(
  VEHICLE_IMAGE_CATALOG.filter(
    (a) => a.approvalStatus === 'approved' && a.identityVerified && a.assetKey,
  ).map((a) => a.assetKey as string),
);

/** Whether a stored catalog key is still an approved registry image. */
export function isApprovedCatalogAssetKey(key: string): boolean {
  return APPROVED_KEYS.has(key);
}
