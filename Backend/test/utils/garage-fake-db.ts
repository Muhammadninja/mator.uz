/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- an untyped in-memory stand-in for the Prisma delegates the Garage uses */
/**
 * In-memory stand-in for the Prisma delegates the Garage add flow uses
 * (VehiclesService + VehicleImagesService), with the catalog rows production
 * has (snapshot 2026-11-13T09:42Z, Chevrolet + one VW model). Test-only.
 */
import { VehicleImageStatus } from '@prisma/client';

type Row = Record<string, any>;

const model = (
  id: string,
  name: string,
  over: Partial<Row> = {},
  makeId = 'chevrolet',
): Row => ({
  id,
  makeId,
  name,
  bodyType: null,
  yearFrom: null,
  yearTo: null,
  variantOfModelId: null,
  ...over,
});

/** Chevrolet + VW rows as production has them (snapshot 2026-11-13T09:42Z). */
export function catalog() {
  const models = [
    model('cobalt', 'Cobalt', { bodyType: 'Sedan' }),
    model('gentra', 'Gentra'),
    model('lacetti', 'Lacetti'),
    model('nexia', 'Nexia'),
    model('nexia-1', 'Nexia 1', {
      yearFrom: 1996,
      yearTo: 2008,
      variantOfModelId: 'nexia',
    }),
    model('nexia-2', 'Nexia 2', {
      yearFrom: 2008,
      yearTo: 2016,
      variantOfModelId: 'nexia',
    }),
    model('nexia-3', 'Nexia 3', {
      yearFrom: 2016,
      yearTo: 2022,
      bodyType: 'Sedan',
      variantOfModelId: 'nexia',
    }),
    model('spark', 'Spark'),
    model('tracker', 'Tracker'),
    model('tracker-2', 'Tracker', { bodyType: 'SUV' }),
    model('malibu', 'Malibu', { bodyType: 'Sedan' }),
    model('polo', 'Polo', { bodyType: 'Hatchback' }, 'volkswagen'),
  ];
  return {
    makes: new Map<string, Row>([
      ['chevrolet', { id: 'chevrolet', name: 'Chevrolet', logoUrl: null }],
      ['volkswagen', { id: 'volkswagen', name: 'Volkswagen', logoUrl: null }],
    ]),
    models: new Map(models.map((m) => [m.id, m])),
    vehicles: new Map<string, Row>(),
    identities: new Map<string, Row>(),
    outbox: new Map<string, Row>(),
  };
}
export type Db = ReturnType<typeof catalog>;

const defined = (data: Row) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

export function fakePrisma(db: Db) {
  const variantRow = (m: Row) => ({
    id: m.id,
    makeId: m.makeId,
    name: m.name,
    bodyType: m.bodyType,
    yearFrom: m.yearFrom,
    yearTo: m.yearTo,
  });
  const withVariants = (m: Row | undefined) =>
    m && {
      ...m,
      variants: [...db.models.values()]
        .filter((x) => x.variantOfModelId === m.id)
        .map(variantRow),
    };
  const imageState = (key: string | null) => {
    const r = key ? db.identities.get(key) : null;
    return r
      ? {
          status: r.status,
          reason: r.reason,
          imageUrl: r.imageUrl,
          imageVersion: r.imageVersion,
          catalogAssetKey: r.catalogAssetKey,
          identity: r.identity,
        }
      : null;
  };
  const hydrate = (v: Row) => ({
    ...v,
    make: db.makes.get(v.makeId),
    model: withVariants(db.models.get(v.modelId)),
    trim: null,
    engine: null,
    model3dAsset: null,
    imageIdentity: imageState(v.imageIdentityKey),
  });
  const prisma: any = {
    vehicleMake: {
      findUnique: async ({ where }: any) => {
        const m = db.makes.get(where.id);
        return m ? { id: m.id, name: m.name } : null;
      },
    },
    vehicleModelRef: {
      findUnique: async ({ where }: any) =>
        withVariants(db.models.get(where.id)) ?? null,
      findMany: async ({ where }: any) =>
        [...db.models.values()]
          .filter((m) => m.makeId === where.makeId && m.id !== where.id.not)
          .map((m) => ({ name: m.name })),
    },
    vehicleTrim: { findUnique: async () => null },
    vehicleEngine: { findUnique: async () => null },
    vehicle3dAsset: { findFirst: async () => null },
    vehicle: {
      count: async ({ where }: any) =>
        [...db.vehicles.values()].filter(
          (v) => v.userId === where.userId && !v.deletedAt,
        ).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const v of db.vehicles.values()) {
          if (v.userId !== where.userId || v.isPrimary !== where.isPrimary)
            continue;
          if (where.id?.not && v.id === where.id.not) continue;
          Object.assign(v, data);
          count++;
        }
        return { count };
      },
      create: async ({ data }: any) => {
        const now = new Date();
        const row: Row = {
          trimId: null,
          engineId: null,
          variantModelId: null,
          imageIdentityKey: null,
          imageReviewReason: null,
          identityModelId: null,
          identityGenerationId: null,
          identityFaceliftId: null,
          identityMarket: null,
          deletedAt: null,
          ...defined(data),
          createdAt: now,
          updatedAt: now,
        };
        db.vehicles.set(row.id, row);
        return hydrate(row);
      },
      findUnique: async ({ where, include, select }: any) => {
        const v = db.vehicles.get(where.id);
        if (!v) return null;
        if (select)
          return {
            imageReviewReason: v.imageReviewReason,
            imageIdentity: imageState(v.imageIdentityKey),
          };
        return include ? hydrate(v) : { ...v };
      },
      findMany: async ({ where }: any) =>
        [...db.vehicles.values()]
          .filter((v) => v.userId === where.userId && !v.deletedAt)
          .map(hydrate),
      update: async ({ where, data }: any) => {
        const v = db.vehicles.get(where.id)!;
        Object.assign(v, defined(data), { updatedAt: new Date() });
        return hydrate(v);
      },
    },
    vehicleImageIdentity: {
      createMany: async ({ data }: any) => {
        let count = 0;
        for (const d of data) {
          if (db.identities.has(d.identityKey)) continue;
          db.identities.set(d.identityKey, {
            status: VehicleImageStatus.PENDING,
            reason: null,
            imageUrl: null,
            imageVersion: null,
            catalogAssetKey: null,
            lastSyncedAt: null,
            nextSyncAt: null,
            ...d,
          });
          count++;
        }
        return { count };
      },
      update: async ({ where, data }: any) =>
        Object.assign(db.identities.get(where.identityKey)!, data),
      updateMany: async ({ where, data }: any) => {
        const r = db.identities.get(where.identityKey);
        if (!r || !Object.entries(where).every(([k, val]) => r[k] === val))
          return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const r = db.identities.get(where.identityKey);
        if (!r) throw new Error('identity not found');
        return { ...r };
      },
    },
    vehicleImageOutbox: {
      findFirst: async ({ where }: any) =>
        [...db.outbox.values()].find(
          (o) =>
            o.identityKey === where.identityKey && o.status === where.status,
        ) ?? null,
      createMany: async ({ data }: any) => {
        let count = 0;
        for (const d of data) {
          const open = [...db.outbox.values()].some(
            (o) => o.identityKey === d.identityKey && o.status === 'PENDING',
          );
          if (open) continue; // the partial unique index
          db.outbox.set(d.id, { status: 'PENDING', attempts: 0, ...d });
          count++;
        }
        return { count };
      },
    },
  };
  prisma.$transaction = async (fn: (tx: any) => unknown) => fn(prisma);
  return prisma;
}
