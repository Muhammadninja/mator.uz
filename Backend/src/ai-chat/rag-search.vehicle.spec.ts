import { Prisma } from '@prisma/client';
import { RagSearchService } from './rag-search.service';
import { createPrismaMock, fakeDiscounts } from '../../test/utils/harness';

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Фильтр ${id}`,
  priceUzs: new Prisma.Decimal(50000),
  categoryId: null,
  sellerId: 's1',
  category: null,
  brand: null,
  isUniversal: false,
  compatibilities: [],
  fitmentBindings: [],
  ...extra,
});

const VEHICLE = { modelId: 'cobalt', trimId: null, engineId: null, year: 2020 };

async function search(rows: unknown[], vehicle: typeof VEHICLE | null) {
  const prisma = createPrismaMock();
  prisma.catalogPart.findMany.mockResolvedValue(rows);
  const service = new RagSearchService(prisma as never, fakeDiscounts() as never);
  return service.searchInStock({ partName: 'фильтр', brand: null, model: null, vehicle });
}

describe('RagSearchService — fit against the selected vehicle', () => {
  it('no data stays unknown, never "fits"', async () => {
    const { items } = await search([row('a')], VEHICLE);
    expect(items[0].fit).toBe('UNKNOWN');
  });

  it('a curated binding to this model fits', async () => {
    const { items } = await search(
      [row('a', { fitmentBindings: [{ vehicleModelId: 'cobalt' }] })],
      VEHICLE,
    );
    expect(items[0].fit).toBe('FITS');
  });

  it('a universal part fits', async () => {
    const { items } = await search([row('a', { isUniversal: true })], VEHICLE);
    expect(items[0].fit).toBe('FITS');
  });

  it('a confirmed misfit is left out, and alone counts as not found', async () => {
    const result = await search(
      [row('a', { fitmentBindings: [{ vehicleModelId: 'malibu' }] })],
      VEHICLE,
    );
    expect(result).toEqual({ found: false, items: [] });
  });

  it('confirmed fits rank above unknown ones', async () => {
    const { items } = await search(
      [row('a'), row('b', { fitmentBindings: [{ vehicleModelId: 'cobalt' }] })],
      VEHICLE,
    );
    expect(items.map((i) => i.fit)).toEqual(['FITS', 'UNKNOWN']);
  });

  it('with no vehicle, fit is not claimed either way', async () => {
    const { items } = await search(
      [row('a', { fitmentBindings: [{ vehicleModelId: 'malibu' }] })],
      null,
    );
    expect(items[0].fit).toBeNull();
  });
});
