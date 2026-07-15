// Tests for persistVehicleLinks — the writer that turns parsed (brand, model)
// pairs into brands / car_models / part_models rows, and clears links for
// universal parts. Uses an in-memory stub of the Prisma slice so the row
// behavior (counts, brand ownership, dedup, universal cleanup) is observable.

import { persistVehicleLinks, VehicleLinkDb } from './vehicle-links';

/** In-memory VehicleLinkDb capturing rows the way Postgres would hold them. */
function makeDb() {
  const brands = new Map<string, { id: number; name: string }>();
  const carModels = new Map<string, { id: number; brandId: number; name: string }>();
  const partModels = new Set<string>(); // "partId:modelId"
  let nextBrandId = 1;
  let nextModelId = 1;

  const db: VehicleLinkDb = {
    brand: {
      async upsert({ where, create }) {
        const existing = brands.get(where.name);
        if (existing) return existing;
        const row = { id: nextBrandId++, name: create.name };
        brands.set(row.name, row);
        return row;
      },
    },
    carModel: {
      async upsert({ where, create }) {
        const key = `${where.brandId_name.brandId}:${where.brandId_name.name}`;
        const existing = carModels.get(key);
        if (existing) return existing;
        const row = { id: nextModelId++, brandId: create.brandId, name: create.name };
        carModels.set(key, row);
        return row;
      },
    },
    partModel: {
      async upsert({ where }) {
        partModels.add(`${where.partId_modelId.partId}:${where.partId_modelId.modelId}`);
        return {};
      },
      async deleteMany({ where }) {
        for (const key of [...partModels]) {
          if (key.startsWith(`${where.partId}:`)) partModels.delete(key);
        }
        return { count: 0 };
      },
    },
  };

  return { db, brands, carModels, partModels };
}

describe('persistVehicleLinks', () => {
  it('SINGLE: one vehicle → exactly one part_models row', async () => {
    const { db, partModels, brands, carModels } = makeDb();

    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [{ brand: 'Chevrolet', model: 'Cobalt' }],
    });

    expect(partModels.size).toBe(1);
    expect(brands.get('Chevrolet')).toBeDefined();
    expect([...carModels.values()]).toEqual([
      { id: 1, brandId: brands.get('Chevrolet')!.id, name: 'Cobalt' },
    ]);
  });

  it('MULTIPLE: N vehicles → N part_models rows', async () => {
    const { db, partModels } = makeDb();

    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Chevrolet', model: 'Gentra' },
        { brand: 'Chevrolet', model: 'Lacetti' },
      ],
    });

    expect(partModels.size).toBe(3);
  });

  it('duplicate pairs do not create duplicate relationships (idempotent upserts)', async () => {
    const { db, partModels, carModels } = makeDb();
    const compat = {
      isUniversal: false,
      vehicles: [
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Chevrolet', model: 'Cobalt' }, // duplicate pair
      ],
    };

    await persistVehicleLinks(db, 100, compat);
    await persistVehicleLinks(db, 100, compat); // re-commit of the same listing

    expect(partModels.size).toBe(1);
    expect(carModels.size).toBe(1);
  });

  it('UNIVERSAL: creates no rows and clears stale links from a previous commit', async () => {
    const { db, partModels } = makeDb();
    // Previous commit linked the product to two models…
    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Chevrolet', model: 'Gentra' },
      ],
    });
    expect(partModels.size).toBe(2);

    // …then the seller re-lists it as universal.
    await persistVehicleLinks(db, 100, { isUniversal: true, vehicles: [] });

    expect(partModels.size).toBe(0);
  });

  it('UNIVERSAL cleanup only touches the given product', async () => {
    const { db, partModels } = makeDb();
    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [{ brand: 'Chevrolet', model: 'Cobalt' }],
    });
    await persistVehicleLinks(db, 200, { isUniversal: true, vehicles: [] });

    expect(partModels.size).toBe(1); // product 100 keeps its link
  });

  it('RE-LIST WITH NO VEHICLE: clears the previous links (regression: stale Audi 100)', async () => {
    const { db, partModels } = makeDb();
    // First published naming a vehicle…
    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [{ brand: 'Audi', model: '100' }],
    });
    expect(partModels.size).toBe(1);

    // …then re-listed (same product, matched by GM number) with title/description/
    // GM only — NO vehicle. The old link must NOT linger; before the fix it did,
    // and projected a phantom "Audi 100" fit into catalog_part_fits.
    await persistVehicleLinks(db, 100, { isUniversal: false, vehicles: [] });
    expect(partModels.size).toBe(0);
  });

  it('RE-LIST WITH A DIFFERENT VEHICLE: replaces old links instead of accumulating', async () => {
    const { db, partModels } = makeDb();
    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [{ brand: 'Audi', model: '100' }],
    });
    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [{ brand: 'Chevrolet', model: 'Cobalt' }],
    });
    // Only the new vehicle survives — the stale Audi 100 is reconciled away.
    expect(partModels.size).toBe(1);
  });

  it('reconcile-clear only touches the given product (a no-vehicle re-list of one keeps the other)', async () => {
    const { db, partModels } = makeDb();
    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [{ brand: 'Chevrolet', model: 'Cobalt' }],
    });
    await persistVehicleLinks(db, 200, {
      isUniversal: false,
      vehicles: [{ brand: 'Audi', model: '100' }],
    });
    // Re-list product 200 with no vehicle: only its link is cleared.
    await persistVehicleLinks(db, 200, { isUniversal: false, vehicles: [] });
    expect(partModels.size).toBe(1); // product 100 still linked
  });

  it('cross-brand pairs create each model under ITS OWN brand', async () => {
    const { db, brands, carModels, partModels } = makeDb();

    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Hyundai', model: 'Solaris' },
      ],
    });

    const chevroletId = brands.get('Chevrolet')!.id;
    const hyundaiId = brands.get('Hyundai')!.id;
    const rows = [...carModels.values()];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ brandId: chevroletId, name: 'Cobalt' }),
        expect.objectContaining({ brandId: hyundaiId, name: 'Solaris' }),
      ]),
    );
    // NOT every model under one brand:
    expect(rows.every((m) => m.brandId === chevroletId)).toBe(false);
    expect(partModels.size).toBe(2);
  });

  it('skips pairs without a resolvable brand (CarModel requires a Brand)', async () => {
    const { db, partModels, brands } = makeDb();

    await persistVehicleLinks(db, 100, {
      isUniversal: false,
      vehicles: [
        { brand: null, model: 'Mystery' },
        { brand: 'Chevrolet', model: 'Cobalt' },
      ],
    });

    expect(brands.has('Chevrolet')).toBe(true);
    expect(brands.size).toBe(1);
    expect(partModels.size).toBe(1); // only the resolvable pair
  });
});
