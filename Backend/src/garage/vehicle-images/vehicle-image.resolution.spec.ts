/* eslint-disable @typescript-eslint/no-unsafe-assignment -- plan fixtures are untyped by design */
import { planVehicleImage } from './vehicle-image.resolution';
import { canonicalIdentityKey } from './vehicle-image.identity';
import type { CatalogAsset } from './vehicle-image.catalog';

const CHEVROLET = { id: 'chevrolet', name: 'Chevrolet' };
const row = (id: string, name: string, bodyType: string | null = null) => ({
  id,
  makeId: 'chevrolet',
  name,
  bodyType,
  yearFrom: null,
  yearTo: null,
});
const src = (
  model: ReturnType<typeof row>,
  year: number,
  over: Record<string, unknown> = {},
) => ({
  year,
  make: CHEVROLET,
  model,
  trim: null,
  siblingModelNames: ['Gentra', 'Malibu'],
  ...over,
});

describe('planVehicleImage', () => {
  it('Cobalt 2020: market-aware identity, saved snapshot, exact approved image', () => {
    const plan = planVehicleImage(src(row('cobalt', 'Cobalt', 'Sedan'), 2020));
    expect(plan).toEqual({
      kind: 'request',
      verification: 'verified',
      identity: {
        makeId: 'chevrolet',
        modelId: 'cobalt',
        modelYear: 2020,
        generationId: null,
        faceliftId: null,
        bodyType: 'Sedan',
        trimId: null,
        marketRegion: 'UZ',
      },
      display: {
        manufacturer: 'Chevrolet',
        model: 'Cobalt',
        marketRegion: 'UZ',
      },
      identityKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      resolved: {
        modelId: 'cobalt',
        generationId: 'cobalt-gen2',
        faceliftId: null,
        marketRegion: 'UZ',
      },
      catalogAsset: { assetKey: 'cobalt-gen2', match: 'exact' },
    });
  });

  it('keeps the identity key a previously global UZ configuration produced (no reassignment)', () => {
    const plan = planVehicleImage(src(row('cobalt', 'Cobalt', 'Sedan'), 2020));
    expect(plan.kind === 'request' && plan.identityKey).toBe(
      canonicalIdentityKey({
        makeId: 'chevrolet',
        modelId: 'cobalt',
        modelYear: 2020,
        generationId: null,
        faceliftId: null,
        bodyType: 'Sedan',
        trimId: null,
        marketRegion: 'UZ',
      }),
    );
  });

  it('Nexia 2 (no approved image) is a verified request with no catalog image', () => {
    const plan = planVehicleImage(src(row('nexia-2', 'Nexia 2'), 2012));
    expect(plan).toMatchObject({
      kind: 'request',
      resolved: {
        modelId: 'nexia-2',
        generationId: 'nexia-2',
        marketRegion: 'UZ',
      },
      catalogAsset: null,
    });
  });

  it('a shared model name is no reason to wait: Tracker 2022 gets its own unverified identity', () => {
    const plan = planVehicleImage(
      src(row('tracker', 'Tracker'), 2022, { siblingModelNames: ['Tracker'] }),
    );
    expect(plan).toMatchObject({
      kind: 'request',
      verification: 'unverified',
      identity: { modelId: 'tracker', identityStatus: 'unverified' },
      display: { manufacturer: 'Chevrolet', model: 'Tracker' },
      resolved: { modelId: 'tracker', generationId: null, faceliftId: null, marketRegion: null },
      catalogAsset: null,
    });
  });

  it('no verified market → an UNVERIFIED identity (no market guessed), never a catalog image', () => {
    const spark = planVehicleImage(src(row('spark', 'Spark'), 2020));
    expect(spark).toMatchObject({ kind: 'request', verification: 'unverified', catalogAsset: null });
    if (spark.kind !== 'request') return;
    expect(spark.identity).not.toHaveProperty('marketRegion');
    expect(spark.display).not.toHaveProperty('marketRegion');
    // Outside the verified Cobalt years: unverified, and never the approved Cobalt image.
    expect(planVehicleImage(src(row('cobalt', 'Cobalt'), 2012))).toMatchObject({
      kind: 'request',
      verification: 'unverified',
      catalogAsset: null,
      resolved: { marketRegion: null },
    });
    expect(
      planVehicleImage({ ...src(row('cobalt', 'Cobalt'), 2020), make: null }),
    ).toEqual({
      kind: 'review',
      reason: 'identity_invalid',
    });
  });

  const asset = (over: Partial<CatalogAsset>): CatalogAsset => ({
    id: 'a',
    makeId: 'chevrolet',
    modelMappings: [{ modelId: 'spark', yearFrom: 2010, yearTo: 2022 }],
    generationId: null,
    faceliftId: null,
    marketRegion: 'UZ',
    identityVerified: true,
    generationVerified: true,
    approvalStatus: 'approved',
    assetKey: 'spark-a',
    ...over,
  });

  it('two approved images answering equally is ambiguous: review, not a guess', () => {
    const catalog = [
      asset({ id: 'a' }),
      asset({ id: 'b', assetKey: 'spark-b' }),
    ];
    expect(planVehicleImage(src(row('spark', 'Spark'), 2020), catalog)).toEqual(
      {
        kind: 'review',
        reason: 'catalog_ambiguous',
      },
    );
  });

  it('a rejected registry image keeps the vehicle on review (no generation over it)', () => {
    const catalog = [asset({ approvalStatus: 'rejected' })];
    expect(planVehicleImage(src(row('spark', 'Spark'), 2020), catalog)).toEqual(
      {
        kind: 'review',
        reason: 'catalog_image_rejected',
      },
    );
  });
});
