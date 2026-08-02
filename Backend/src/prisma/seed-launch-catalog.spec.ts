import { OilType, PartCondition, ProductKind } from '@prisma/client';
import { createPrismaMock, PrismaMock } from '../../test/utils/harness';
import * as dataset from './seed-data/launch-catalog.seed';
import { seedLaunchCatalog, launchDatasetIsEmpty } from './seed-launch-catalog';

/**
 * The launch-catalogue loader. The dataset arrays are module-level constants, so
 * each test swaps their CONTENTS in place (splice, not reassign) and restores
 * them afterwards — the loader reads the same array instances.
 */

function setDataset(over: {
  brands?: dataset.SeedPartBrand[];
  dealers?: dataset.SeedLaunchDealer[];
  products?: dataset.SeedProduct[];
  sales?: dataset.SeedSale[];
}) {
  dataset.SEED_PART_BRANDS.splice(
    0,
    dataset.SEED_PART_BRANDS.length,
    ...(over.brands ?? []),
  );
  dataset.SEED_LAUNCH_DEALERS.splice(
    0,
    dataset.SEED_LAUNCH_DEALERS.length,
    ...(over.dealers ?? []),
  );
  dataset.SEED_PRODUCTS.splice(
    0,
    dataset.SEED_PRODUCTS.length,
    ...(over.products ?? []),
  );
  dataset.SEED_SALES.splice(
    0,
    dataset.SEED_SALES.length,
    ...(over.sales ?? []),
  );
}

const sparePart = (
  over: Partial<dataset.SeedSparePart> = {},
): dataset.SeedSparePart => ({
  id: 'part_pads',
  kind: 'SPARE_PART',
  title: 'Brake pads',
  categoryId: 'brakes',
  sellerId: 'dealer_a',
  brandId: 'brand_bosch',
  priceUzs: 185000,
  stockQty: 10,
  ...over,
});

const motorOil = (
  over: Partial<dataset.SeedMotorOil> = {},
): dataset.SeedMotorOil => ({
  id: 'part_oil',
  kind: 'MOTOR_OIL',
  title: 'Engine oil 5W-30',
  categoryId: 'motor-oil',
  sellerId: 'dealer_a',
  priceUzs: 320000,
  stockQty: 5,
  viscosity: '5W-30',
  oilType: OilType.SYNTHETIC,
  volumeMl: 4000,
  ...over,
});

describe('seedLaunchCatalog', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = createPrismaMock();
    // The FK universe the validator resolves against.
    prisma.partCategory.findMany.mockResolvedValue([
      { id: 'brakes' },
      { id: 'motor-oil' },
    ]);
    prisma.catalogSeller.findMany.mockResolvedValue([{ id: 'dealer_a' }]);
    prisma.partBrand.findMany.mockResolvedValue([{ id: 'brand_bosch' }]);
  });

  afterEach(() => setDataset({}));

  describe('the shipped dataset', () => {
    it('is empty — no fabricated production data', () => {
      // Guards the rule directly: if someone later fills these arrays with
      // placeholder rows, this fails.
      expect(dataset.SEED_PART_BRANDS).toEqual([]);
      expect(dataset.SEED_LAUNCH_DEALERS).toEqual([]);
      expect(dataset.SEED_PRODUCTS).toEqual([]);
      expect(dataset.SEED_SALES).toEqual([]);
      expect(launchDatasetIsEmpty()).toBe(true);
    });

    it('loads cleanly as a no-op against a clean database', async () => {
      const counts = await seedLaunchCatalog(prisma);
      expect(counts).toEqual({
        part_brands: 0,
        launch_dealers: 0,
        spare_parts: 0,
        motor_oils: 0,
        sales: 0,
      });
      expect(prisma.catalogPart.upsert).not.toHaveBeenCalled();
    });
  });

  describe('writes', () => {
    it('upserts every row on its stable id — never create-only', async () => {
      setDataset({
        brands: [{ id: 'brand_gates', name: 'Gates' }],
        dealers: [{ id: 'dealer_b', name: 'Prime Motors' }],
        products: [sparePart()],
      });
      await seedLaunchCatalog(prisma);

      expect(prisma.partBrand.upsert.mock.calls[0][0].where).toEqual({
        id: 'brand_gates',
      });
      expect(prisma.catalogSeller.upsert.mock.calls[0][0].where).toEqual({
        id: 'dealer_b',
      });
      expect(prisma.catalogPart.upsert.mock.calls[0][0].where).toEqual({
        id: 'part_pads',
      });
      // create() is never used for an identity-bearing row.
      expect(prisma.catalogPart.create).not.toHaveBeenCalled();
      expect(prisma.partBrand.create).not.toHaveBeenCalled();
    });

    it('never deletes a product, dealer or brand', async () => {
      setDataset({ products: [sparePart()] });
      await seedLaunchCatalog(prisma);

      expect(prisma.catalogPart.deleteMany).not.toHaveBeenCalled();
      expect(prisma.catalogSeller.deleteMany).not.toHaveBeenCalled();
      expect(prisma.partBrand.deleteMany).not.toHaveBeenCalled();
      expect(prisma.sale.deleteMany).not.toHaveBeenCalled();
    });

    it('derives in_stock from the stock count', async () => {
      setDataset({ products: [sparePart({ stockQty: 0 })] });
      await seedLaunchCatalog(prisma);
      expect(prisma.catalogPart.upsert.mock.calls[0][0].create.inStock).toBe(
        false,
      );
    });

    it('seeds a launch dealer as ACTIVE and curated', async () => {
      setDataset({
        dealers: [{ id: 'dealer_b', name: 'Prime', brandColor: '#FF0000' }],
      });
      await seedLaunchCatalog(prisma);

      const row = prisma.catalogSeller.upsert.mock.calls[0][0].create;
      expect(row.status).toBe('ACTIVE');
      expect(row.isCurated).toBe(true);
      // Both colour surfaces agree.
      expect(row.color).toBe('#FF0000');
      expect(row.brandColor).toBe('#FF0000');
    });
  });

  describe('motor oil', () => {
    it('is seeded with oil attributes, no part numbers, and as universal', async () => {
      setDataset({ products: [motorOil()] });
      await seedLaunchCatalog(prisma);

      const row = prisma.catalogPart.upsert.mock.calls[0][0].create;
      expect(row.kind).toBe(ProductKind.MOTOR_OIL);
      expect(row.oilViscosity).toBe('5W-30');
      expect(row.oilType).toBe(OilType.SYNTHETIC);
      expect(row.oilVolumeMl).toBe(4000);
      // Never pushed through the spare-part fitment rules.
      expect(row.oemNumbers).toEqual([]);
      expect(row.gmNumbers).toEqual([]);
      expect(row.isUniversal).toBe(true);
      expect(prisma.catalogPartFit.create).not.toHaveBeenCalled();
    });

    it('clears oil columns on a spare part', async () => {
      setDataset({ products: [sparePart()] });
      await seedLaunchCatalog(prisma);

      const row = prisma.catalogPart.upsert.mock.calls[0][0].update;
      expect(row.oilViscosity).toBeNull();
      expect(row.oilType).toBeNull();
      expect(row.oilVolumeMl).toBeNull();
    });

    it('rejects an oil with a non-positive volume', async () => {
      setDataset({ products: [motorOil({ volumeMl: 0 })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /volumeMl must be a positive integer/,
      );
    });

    it('rejects an oil with no viscosity', async () => {
      setDataset({ products: [motorOil({ viscosity: '  ' })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /viscosity is required/,
      );
    });
  });

  describe('fitment', () => {
    it('replaces fitment scoped to the product being seeded', async () => {
      setDataset({
        products: [
          sparePart({
            fits: [
              {
                makeSlug: 'make_chevrolet',
                makeName: 'Chevrolet',
                modelSlug: 'model_cobalt',
                modelName: 'Cobalt',
              },
            ],
          }),
        ],
      });
      await seedLaunchCatalog(prisma);

      // The only delete in the seed, and it names one product.
      expect(prisma.catalogPartFit.deleteMany).toHaveBeenCalledWith({
        where: { partId: 'part_pads' },
      });
      const fit = prisma.catalogPartFit.create.mock.calls[0][0].data;
      expect(fit).toEqual({
        partId: 'part_pads',
        makeSlug: 'make_chevrolet',
        makeName: 'Chevrolet',
        modelSlug: 'model_cobalt',
        modelName: 'Cobalt',
      });
    });

    it('writes no fitment for a universal spare part', async () => {
      setDataset({
        products: [
          sparePart({
            isUniversal: true,
            fits: [
              { makeSlug: 'm', makeName: 'M', modelSlug: 's', modelName: 'S' },
            ],
          }),
        ],
      });
      await seedLaunchCatalog(prisma);
      expect(prisma.catalogPartFit.create).not.toHaveBeenCalled();
    });
  });

  describe('referential validation', () => {
    it('rejects a product in an unknown category', async () => {
      setDataset({ products: [sparePart({ categoryId: 'nope' })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /unknown categoryId "nope"/,
      );
      expect(prisma.catalogPart.upsert).not.toHaveBeenCalled();
    });

    it('rejects a product with an unknown seller', async () => {
      setDataset({ products: [sparePart({ sellerId: 'ghost' })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /unknown sellerId "ghost"/,
      );
    });

    it('accepts a seller supplied by this same dataset', async () => {
      setDataset({
        dealers: [{ id: 'dealer_new', name: 'New' }],
        products: [sparePart({ sellerId: 'dealer_new' })],
      });
      await expect(seedLaunchCatalog(prisma)).resolves.toBeDefined();
    });

    it('rejects duplicate ids in the dataset', async () => {
      setDataset({ products: [sparePart(), sparePart()] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /duplicate id "part_pads"/,
      );
    });

    it('reports every problem at once rather than only the first', async () => {
      setDataset({
        products: [sparePart({ categoryId: 'nope', sellerId: 'ghost' })],
      });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /unknown categoryId[\s\S]*unknown sellerId/,
      );
    });
  });

  describe('money', () => {
    it('rejects a fractional price — money is whole UZS, never a float', async () => {
      setDataset({ products: [sparePart({ priceUzs: 185000.5 })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /non-negative integer in whole UZS/,
      );
    });

    it('rejects a negative price', async () => {
      setDataset({ products: [sparePart({ priceUzs: -1 })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /non-negative integer in whole UZS/,
      );
    });

    it('rejects a negative stock count', async () => {
      setDataset({ products: [sparePart({ stockQty: -3 })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /stockQty must be a non-negative integer/,
      );
    });
  });

  describe('sales', () => {
    const sale = (over: Partial<dataset.SeedSale> = {}): dataset.SeedSale => ({
      id: 'sale_launch',
      title: 'Launch week',
      discountType: 'PERCENT',
      discountValue: 15,
      scopeType: 'ALL_PRODUCTS',
      startAt: '2026-08-01T00:00:00Z',
      ...over,
    });

    it('replaces targets per sale so a re-seed cannot widen a campaign', async () => {
      setDataset({
        sales: [sale({ scopeType: 'CATEGORIES', targetIds: ['brakes'] })],
      });
      await seedLaunchCatalog(prisma);

      expect(prisma.saleTarget.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale_launch' },
      });
      expect(prisma.saleTarget.create.mock.calls[0][0].data.targetId).toBe(
        'brakes',
      );
    });

    it('rejects a percentage outside (0, 100]', async () => {
      setDataset({ sales: [sale({ discountValue: 120 })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /PERCENT discount must be in \(0, 100\]/,
      );
    });

    it('rejects a scoped sale with no targets', async () => {
      setDataset({ sales: [sale({ scopeType: 'PRODUCTS', targetIds: [] })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /requires at least one targetId/,
      );
    });

    it('rejects an end date at or before the start', async () => {
      setDataset({ sales: [sale({ endAt: '2026-07-01T00:00:00Z' })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /endAt must be after startAt/,
      );
    });

    it('rejects an unparseable date', async () => {
      setDataset({ sales: [sale({ startAt: 'last tuesday' })] });
      await expect(seedLaunchCatalog(prisma)).rejects.toThrow(
        /not a valid ISO-8601 instant/,
      );
    });
  });

  describe('idempotency', () => {
    it('produces byte-identical writes on a second run', async () => {
      const products = [sparePart(), motorOil()];
      setDataset({ brands: [{ id: 'brand_gates', name: 'Gates' }], products });

      await seedLaunchCatalog(prisma);
      const first = prisma.catalogPart.upsert.mock.calls.map((c: unknown[]) =>
        JSON.stringify(c[0]),
      );

      const second = createPrismaMock();
      second.partCategory.findMany.mockResolvedValue([
        { id: 'brakes' },
        { id: 'motor-oil' },
      ]);
      second.catalogSeller.findMany.mockResolvedValue([{ id: 'dealer_a' }]);
      second.partBrand.findMany.mockResolvedValue([{ id: 'brand_bosch' }]);
      await seedLaunchCatalog(second);
      const repeat = second.catalogPart.upsert.mock.calls.map((c: unknown[]) =>
        JSON.stringify(c[0]),
      );

      // Deterministic: no generated ids, no now()-derived values in the payload.
      expect(repeat).toEqual(first);
    });

    it('reports the same counts on every run', async () => {
      setDataset({ products: [sparePart(), motorOil()] });
      const a = await seedLaunchCatalog(prisma);
      const b = await seedLaunchCatalog(prisma);
      expect(b).toEqual(a);
      expect(a).toMatchObject({ spare_parts: 1, motor_oils: 1 });
    });
  });

  it('runs the whole load inside one transaction', async () => {
    setDataset({ products: [sparePart()] });
    await seedLaunchCatalog(prisma);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
