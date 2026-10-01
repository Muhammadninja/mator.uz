/**
 * Localization of the buyer category grid, plus the CACHE property that makes
 * it safe: category rows are cached with ALL THREE names and the language is
 * applied at presentation, so a warm cache populated by a Russian request can
 * still serve an Uzbek one correctly. (Had the cache stored one resolved label,
 * the second language would have been served the first one's strings.)
 */

import { CategoriesService } from './categories.service';
import { createPrismaMock, PrismaMock } from '../../../test/utils/harness';
import { vehicleFitWhere } from '../compatibility/vehicle-fitment';
import { buyerVisible } from '../buyer-visibility';
import { selectIds } from '../compatibility/where-eval.test-util';
import * as fx from '../compatibility/fitment-fixtures.test-util';

const ROWS = [
  {
    id: 'brakes',
    name: 'Brakes',
    nameRu: 'Тормоза',
    nameUz: 'Tormozlar',
    nameEn: 'Brakes',
    slug: 'brakes',
    iconKey: 'brake',
    color: '#f00',
    mainCategory: 'BRAKES',
  },
  {
    id: 'engine',
    name: 'Engine',
    nameRu: 'Двигатель',
    nameUz: 'Dvigatel',
    nameEn: 'Engine',
    slug: 'engine',
    iconKey: 'engine',
    color: '#0f0',
    mainCategory: 'ENGINE',
  },
];

const LABELS = {
  ru: ['Тормоза', 'Двигатель'],
  uz: ['Tormozlar', 'Dvigatel'],
  en: ['Brakes', 'Engine'],
} as const;

describe('CategoriesService — grid localization', () => {
  let prisma: PrismaMock;
  let svc: CategoriesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    svc = new CategoriesService(prisma);
    prisma.partCategory.findMany.mockResolvedValue(ROWS);
    prisma.catalogPart.groupBy.mockResolvedValue([
      { mainCategory: 'BRAKES', _count: { _all: 12 } },
      { mainCategory: 'ENGINE', _count: { _all: 25 } },
    ]);
  });

  it.each(['ru', 'uz', 'en'] as const)('labels the grid in %s', async (lang) => {
    const res = await svc.list({} as never, lang);
    expect(res.items.map((i) => i.label)).toEqual([...LABELS[lang]]);
  });

  it('defaults to Russian when no language is given', async () => {
    const res = await svc.list({} as never);
    expect(res.items.map((i) => i.label)).toEqual([...LABELS.ru]);
  });

  // `name` is the internal canonical label. It stays on the wire for existing
  // clients, so it must NOT start tracking the request language.
  it('keeps the internal `name` language-stable beside the label', async () => {
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const res = await svc.list({} as never, lang);
      expect(res.items.map((i) => i.name)).toEqual(['Brakes', 'Engine']);
    }
  });

  it('keeps all three names on the wire for a client that re-renders locally', async () => {
    const [brakes] = (await svc.list({} as never, 'uz')).items;
    expect(brakes).toMatchObject({
      name_ru: 'Тормоза',
      name_uz: 'Tormozlar',
      name_en: 'Brakes',
    });
  });

  it('reports identical ids, slugs and counts in every language', async () => {
    const shapes = await Promise.all(
      (['ru', 'uz', 'en'] as const).map(async (lang) =>
        (await svc.list({} as never, lang)).items.map(
          ({ id, slug, count }) => ({ id, slug, count }),
        ),
      ),
    );
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[1]).toEqual(shapes[2]);
    expect(shapes[0]).toEqual([
      { id: 'brakes', slug: 'brakes', count: 12 },
      { id: 'engine', slug: 'engine', count: 25 },
    ]);
  });

  /**
   * The regression this guards: a language-blind cache serving the FIRST
   * requester's labels to everyone. The read is language-independent (all three
   * names are selected), so replaying the very same rows under a different
   * language must produce different labels.
   */
  describe('a warm, language-agnostic cache serves every language correctly', () => {
    it('does not serve the previous request’s labels to the next language', async () => {
      const ru = await svc.list({} as never, 'ru');
      // Same underlying rows — exactly what a cache hit would replay.
      const uz = await svc.list({} as never, 'uz');
      const en = await svc.list({} as never, 'en');

      expect(ru.items.map((i) => i.label)).toEqual([...LABELS.ru]);
      expect(uz.items.map((i) => i.label)).toEqual([...LABELS.uz]);
      expect(en.items.map((i) => i.label)).toEqual([...LABELS.en]);
    });

    // The read must not be narrowed to "the current language's column", which
    // is what would make a cached payload language-specific.
    it('selects all three name columns regardless of the language asked for', async () => {
      await svc.list({} as never, 'uz');
      expect(prisma.partCategory.findMany.mock.calls[0][0].select).toMatchObject(
        { nameRu: true, nameUz: true, nameEn: true },
      );
    });

    it('issues an identical query for every language', async () => {
      const calls: unknown[] = [];
      for (const lang of ['ru', 'uz', 'en'] as const) {
        prisma = createPrismaMock();
        prisma.partCategory.findMany.mockResolvedValue(ROWS);
        prisma.catalogPart.groupBy.mockResolvedValue([]);
        await new CategoriesService(prisma).list({} as never, lang);
        calls.push(prisma.partCategory.findMany.mock.calls[0][0]);
      }
      expect(calls[0]).toEqual(calls[1]);
      expect(calls[1]).toEqual(calls[2]);
    });
  });
});

/**
 * Garage-scoped counts use the SAME decision path as the parts listing. The
 * groupBy where-clause is evaluated over in-memory parts (where-eval) and the
 * mocked groupBy counts only the rows it selects — so the asserted number is
 * what that predicate would count, not a canned value.
 */
describe('CategoriesService — garage-scoped counts', () => {
  const PARTS = fx.PARTS.map((p) => ({ ...p, mainCategory: 'BRAKES' }));

  const OWNER = 'usr_owner';

  /** Counts as `userId` sees them; the garage vehicle belongs to OWNER. */
  async function brakesCountFor(
    garage: fx.VehicleKey,
    userId: string | null = OWNER,
  ) {
    const prisma: PrismaMock = createPrismaMock();
    prisma.partCategory.findMany.mockResolvedValue(ROWS);
    // Like the database: the row comes back only for its (live) owner.
    prisma.vehicle.findFirst.mockImplementation(
      ({ where }: { where: { userId?: string; deletedAt?: null } }) =>
        Promise.resolve(
          where.userId === OWNER && where.deletedAt === null
            ? fx.vehicleRow(fx.VEHICLES[garage])
            : null,
        ),
    );
    prisma.catalogPart.groupBy.mockImplementation(
      ({ where }: { where: unknown }) =>
        Promise.resolve([
          {
            mainCategory: 'BRAKES',
            _count: { _all: selectIds(PARTS, where).length },
          },
        ]),
    );
    const res = await new CategoriesService(prisma).list(
      { vehicle_id: 'veh_1' },
      'ru',
      userId,
    );
    return res.items.find((c) => c.id === 'brakes')!.count;
  }

  it('a Cobalt count includes exactly what the Cobalt listing shows', async () => {
    const expected = selectIds(
      PARTS,
      vehicleFitWhere(fx.VEHICLES.cobalt),
    ).length;
    expect(await brakesCountFor('cobalt')).toBe(expected);
  });

  it('a Cobalt count does not include Spark-only parts (curated or legacy)', async () => {
    const withSparkOnly = await brakesCountFor('cobalt');
    // curated_cobalt, curated_multi, legacy_cobalt, makewide_chevrolet,
    // trim_t_cobalt, universal_oil — and NOT curated_spark / legacy_spark /
    // curated_overrides_legacy.
    expect(withSparkOnly).toBe(6);
  });

  it("another user's vehicle_id does not scope the counts (treated as unknown)", async () => {
    const unscoped = selectIds(PARTS, buyerVisible(undefined)).length;
    expect(await brakesCountFor('cobalt', 'usr_other')).toBe(unscoped);
    expect(await brakesCountFor('cobalt', null)).toBe(unscoped);
    expect(unscoped).toBeGreaterThan(await brakesCountFor('cobalt'));
  });

  it('Nexia 2 and Nexia 3 counts differ by their own curated parts', async () => {
    const n2 = selectIds(PARTS, vehicleFitWhere(fx.VEHICLES.nexia2));
    const n3 = selectIds(PARTS, vehicleFitWhere(fx.VEHICLES.nexia3));
    expect(n2).toContain('curated_nexia2');
    expect(n3).not.toContain('curated_nexia2');
    expect(await brakesCountFor('nexia2')).toBe(n2.length);
    expect(await brakesCountFor('nexia3')).toBe(n3.length);
  });
});
