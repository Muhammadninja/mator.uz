import { PrismaClient } from '@prisma/client';
import {
  ExistingMake,
  ExistingModel,
  ReferenceSnapshot,
} from '../../src/prisma/vehicle-reference-plan';

/** A reference make row; inactive and not "coming soon" unless stated. */
export const referenceMake = (
  id: string,
  name: string,
  sortOrder: number,
  isActive = false,
  comingSoon = false,
): ExistingMake => ({ id, name, sortOrder, isActive, comingSoon });

const models = (makeId: string, rows: [string, string][]): ExistingModel[] =>
  rows.map(([id, name], i) => ({ id, makeId, name, sortOrder: i }));

/**
 * Production reference state on 2026-09-25 (G-2 Phase 1 audit): active makes
 * and models as the live Reference API served them, plus the inactive makes and
 * their models (hidden by the API) as the original seed created them.
 * sortOrder values are positional; the live API only exposes the order.
 */
export const PROD_REFERENCE_2026_09_25: ReferenceSnapshot = {
  makes: [
    referenceMake('chevrolet', 'Chevrolet', 0, true),
    referenceMake('byd', 'BYD', 1, true, true),
    referenceMake('daewoo', 'Daewoo', 2),
    referenceMake('kia', 'Kia', 3),
    referenceMake('chery', 'Chery', 4),
    referenceMake('hyundai', 'Hyundai', 5),
    referenceMake('lada', 'Lada', 6),
    referenceMake('toyota', 'Toyota', 7),
    referenceMake('haval', 'Haval', 8),
    referenceMake('nissan', 'Nissan', 9),
    referenceMake('leapmotor', 'Leapmotor', 10, true, true),
    referenceMake('volkswagen', 'Volkswagen', 11, true),
  ],
  models: [
    ...models('chevrolet', [
      ['cobalt', 'Cobalt'],
      ['malibu', 'Malibu'],
      ['orlando', 'Orlando'],
      ['nexia', 'Nexia'],
      ['lacetti', 'Lacetti'],
      ['tracker-2', 'Tracker'],
      ['gentra', 'Gentra'],
      ['spark', 'Spark'],
      ['tracker', 'Tracker'],
      ['nexia-3', 'Nexia 3'],
      ['captiva', 'Captiva'],
      ['onix', 'Onix'],
      ['genrta-lacetti', 'Genrta'],
      ['damas', 'Damas'],
      ['nexia-2', 'Nexia 2'],
    ]),
    ...models('daewoo', [
      ['matiz', 'Matiz'],
      ['tico', 'Tico'],
    ]),
    ...models('byd', [
      ['byd-chazor', 'Chazor'],
      ['byd-song-plus', 'Song Plus'],
      ['byd-han', 'Han'],
    ]),
    ...models('kia', [
      ['kia-k5', 'K5'],
      ['kia-sportage', 'Sportage'],
      ['kia-rio', 'Rio'],
    ]),
    ...models('chery', [
      ['chery-tiggo-7-pro', 'Tiggo 7 Pro'],
      ['chery-tiggo-8-pro', 'Tiggo 8 Pro'],
    ]),
    ...models('hyundai', [
      ['hyundai-sonata', 'Sonata'],
      ['hyundai-tucson', 'Tucson'],
      ['hyundai-creta', 'Creta'],
    ]),
    ...models('lada', [
      ['lada-niva', 'Niva'],
      ['lada-granta', 'Granta'],
    ]),
    ...models('volkswagen', [
      ['polo', 'Polo'],
      ['jetta', 'Jetta'],
      ['passat', 'Passat'],
      ['arteon', 'Arteon'],
      ['golf', 'Golf'],
      ['e-bora', 'e-Bora'],
      ['caddy', 'Caddy'],
      ['tiguan', 'Tiguan'],
      ['teramont', 'Teramont'],
      ['touareg', 'Touareg'],
      ['t-roc', 'T-Roc'],
      ['id-3', 'ID.3'],
      ['id-4', 'ID.4'],
      ['id-6', 'ID.6'],
      ['id-7', 'ID.7'],
      ['tharu-xr', 'Tharu XR'],
      ['lavida-xr', 'Lavida XR'],
    ]),
  ],
};

/**
 * Production reference state on 2026-11-12 (Wave 1 audit), read the same way:
 * Chevrolet, BYD and Volkswagen models as the live Reference API served them,
 * the G-2 rows applied, and the makes that are now inactive (Ravon, SsangYong,
 * Skoda and Genesis were created active by G-2 and later switched off). The
 * API exposes neither sort numbers nor year/body fields, so sortOrder is
 * positional and the facts are unset; the real values come from the snapshot
 * SQL before any apply.
 */
export const PROD_REFERENCE_2026_11_12: ReferenceSnapshot = {
  makes: [
    ...PROD_REFERENCE_2026_09_25.makes.map((m) => ({ ...m })),
    referenceMake('ravon', 'Ravon', 12),
    referenceMake('ssangyong', 'SsangYong', 13),
    referenceMake('skoda', 'Skoda', 14),
    referenceMake('genesis', 'Genesis', 15),
  ],
  models: [
    ...models('chevrolet', [
      ['cobalt', 'Cobalt'],
      ['malibu', 'Malibu'],
      ['orlando', 'Orlando'],
      ['nexia', 'Nexia'],
      ['lacetti', 'Lacetti'],
      ['gentra', 'Gentra'],
      ['tracker-2', 'Tracker'],
      ['spark', 'Spark'],
      ['tracker', 'Tracker'],
      ['nexia-3', 'Nexia 3'],
      ['captiva', 'Captiva'],
      ['onix', 'Onix'],
      ['genrta-lacetti', 'Genrta'],
      ['damas', 'Damas'],
      ['nexia-2', 'Nexia 2'],
      ['chevrolet-matiz', 'Matiz'],
      ['equinox', 'Equinox'],
      ['traverse', 'Traverse'],
      ['tahoe', 'Tahoe'],
      ['trailblazer', 'Trailblazer'],
      ['epica', 'Epica'],
      ['labo', 'Labo'],
      ['nexia-1', 'Nexia 1'],
      ['tacuma', 'Tacuma'],
      ['cruze', 'Cruze'],
    ]),
    ...PROD_REFERENCE_2026_09_25.models
      .filter((m) => m.makeId !== 'chevrolet')
      .map((m) => ({ ...m })),
    ...models('ravon', [['r4-cobalt', 'R4 (Cobalt)']]),
    ...models('ssangyong', [
      ['torres', 'Torres'],
      ['rexton', 'Rexton'],
      ['korando', 'Korando'],
      ['musso', 'Musso'],
    ]),
    ...models('skoda', [['kodiaq', 'Kodiaq']]),
    ...models('genesis', [['g90', 'G90']]),
  ],
};

export const cloneSnapshot = (s: ReferenceSnapshot): ReferenceSnapshot => ({
  makes: s.makes.map((m) => ({ ...m })),
  models: s.models.map((m) => ({ ...m })),
});

interface UpdateManyArgs {
  where: { id: string; isActive: boolean };
  data: { isActive: boolean };
}

/**
 * In-memory stand-in for the two reference tables: enough Prisma surface for
 * the seed, a transaction that rolls back when its callback throws, and a log
 * of every write. Methods the seed must never call (update, upsert, delete…)
 * throw, so a stray call fails the test.
 */
export function fakeReferenceDb(start: ReferenceSnapshot) {
  let state = cloneSnapshot(start);
  const writes: string[] = [];
  const txOptions: unknown[] = [];
  const forbidden = (): never => {
    throw new Error('forbidden write');
  };
  const guards = {
    update: forbidden,
    upsert: forbidden,
    delete: forbidden,
    deleteMany: forbidden,
    createMany: forbidden,
  };

  // Handed to transaction callbacks; filled once `db` exists (a direct
  // self-reference in the initializer would widen `db` to any).
  const self: { db?: unknown } = {};
  const db = {
    vehicleMake: {
      ...guards,
      findMany: jest.fn(() =>
        Promise.resolve(state.makes.map((m) => ({ ...m }))),
      ),
      create: jest.fn(({ data }: { data: ExistingMake }) => {
        if (state.makes.some((m) => m.id === data.id)) {
          return Promise.reject(new Error('P2002'));
        }
        state.makes.push({ ...data });
        writes.push(`create make ${data.id}`);
        return Promise.resolve({ ...data });
      }),
      updateMany: jest.fn(({ where, data }: UpdateManyArgs) => {
        const hit = state.makes.filter(
          (m) => m.id === where.id && m.isActive === where.isActive,
        );
        hit.forEach((m) => Object.assign(m, data));
        writes.push(`updateMany make ${where.id} ${JSON.stringify(data)}`);
        return Promise.resolve({ count: hit.length });
      }),
    },
    vehicleModelRef: {
      ...guards,
      findMany: jest.fn(() =>
        Promise.resolve(state.models.map((m) => ({ ...m }))),
      ),
      create: jest.fn(({ data }: { data: ExistingModel }) => {
        if (state.models.some((m) => m.id === data.id)) {
          return Promise.reject(new Error('P2002'));
        }
        state.models.push({ ...data });
        writes.push(`create model ${data.id}`);
        return Promise.resolve({ ...data });
      }),
    },
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
        txOptions.push(opts);
        const saved = cloneSnapshot(state);
        try {
          return await fn(self.db);
        } catch (err) {
          state = saved;
          throw err;
        }
      },
    ),
  };

  self.db = db;

  return {
    prisma: db as unknown as PrismaClient,
    db,
    writes,
    txOptions,
    state: () => state,
  };
}
