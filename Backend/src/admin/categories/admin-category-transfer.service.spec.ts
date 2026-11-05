// Emptying a category into another, as far as a part's receipt is concerned: the kind
// and oil type have to agree with where it ends up. Prisma is mocked; the rest of the
// transfer (roots, drafts, what remains) is covered against a real database in
// test/integration/admin-category-transfer.int-spec.ts.

import { ConflictException } from '@nestjs/common';
import { OilType, PackageForm, ProductKind } from '@prisma/client';
import { AdminCategoryTransferService } from './admin-category-transfer.service';
import {
  confirmedCategory,
  createPrismaMock,
  fakeAudit,
  PrismaMock,
} from '../../../test/utils/harness';

const node = (id: string, parentId: string | null, over = {}) => ({
  id,
  name: id,
  nameRu: id,
  nameUz: id,
  nameEn: id,
  parentId,
  level: parentId ? 1 : 0,
  isActive: true,
  mxik: null,
  packageCodeSingle: null,
  packageCodeSet: null,
  packageCodeBox: null,
  fiscalConfirmedCodes: null,
  _count: { children: 0 },
  ...over,
});

const TREE = [
  node('motor-oil', null, { _count: { children: 4 } }),
  node('synthetic-motor-oil', 'motor-oil'),
  node('mineral-motor-oil', 'motor-oil'),
  node('transmission-oil', 'motor-oil', {
    mxik: '02710005005000000',
    packageCodeSingle: '1282593',
  }),
  node('other', null),
  node('industrial-oil', 'other'),
  node('maintenance-and-fluids', null),
  node('oil-and-fluids', 'maintenance-and-fluids'),
  node('brake-system', null),
  node('brakes', 'brake-system', {
    mxik: '08708005011000000',
    packageCodeSingle: '1417722',
  }),
  node('brake-discs', 'brake-system', {
    mxik: '08708005012000000',
    packageCodeSingle: '1417730',
  }),
];

type Group = { kind: ProductKind; oilType: OilType | null; count: number };

function world(groups: Group[], tree = TREE) {
  const prisma: PrismaMock = createPrismaMock();
  prisma.partCategory.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) =>
      Promise.resolve(tree.find((n) => n.id === where.id) ?? null),
  );
  prisma.partCategory.findMany.mockResolvedValue(tree);
  const rows = groups.map((g) => ({
    kind: g.kind,
    oilType: g.oilType,
    _count: { _all: g.count },
  }));
  const byKind = ({ by }: { by: string[] }) =>
    Promise.resolve(by.includes('kind') ? rows : []);
  prisma.catalogPart.groupBy.mockImplementation(byKind);
  prisma.product.groupBy.mockImplementation(byKind);
  for (const delegate of [
    prisma.catalogPart,
    prisma.product,
    prisma.productDraft,
  ]) {
    delegate.updateMany.mockResolvedValue({ count: 1 });
  }
  const service = new AdminCategoryTransferService(
    prisma,
    { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
    fakeAudit(),
  );
  return { prisma, service };
}

const oil = (oilType: OilType | null, count = 1): Group => ({
  kind: ProductKind.MOTOR_OIL,
  oilType,
  count,
});
const SPARE: Group = { kind: ProductKind.SPARE_PART, oilType: null, count: 1 };

const codesOf = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('AdminCategoryTransferService — oils', () => {
  it('re-filing between compositions writes the new type everywhere, and warns first', async () => {
    const { service, prisma } = world([oil(OilType.MINERAL, 3)]);

    const { data } = await service.preview(
      'mineral-motor-oil',
      'synthetic-motor-oil',
    );
    expect(data.canTransfer).toBe(true);
    expect(codesOf(data.warnings)).toContain('OIL_TYPE_CHANGES');

    await service.transfer('mineral-motor-oil', {
      targetCategoryId: 'synthetic-motor-oil',
      reason: 'Refile',
    } as never);

    const written = { oilType: OilType.SYNTHETIC };
    expect(prisma.catalogPart.updateMany.mock.calls[0][0].data).toMatchObject(
      written,
    );
    // The listings of a non-spare-part kind, and their live drafts.
    expect(prisma.product.updateMany.mock.calls[1][0].data).toMatchObject(
      written,
    );
    expect(prisma.productDraft.updateMany.mock.calls[1][0].data).toMatchObject(
      written,
    );
  });

  it('transmission oil denotes no composition, so the old type goes', async () => {
    const { service, prisma } = world([oil(OilType.SYNTHETIC)]);

    await service.transfer('synthetic-motor-oil', {
      targetCategoryId: 'transmission-oil',
      reason: 'Refile',
    } as never);

    expect(prisma.catalogPart.updateMany.mock.calls[0][0].data).toMatchObject({
      categoryId: 'transmission-oil',
      oilType: null,
    });
  });

  it('a type sellers stated elsewhere blocks: one composition cannot hold them all', async () => {
    const { service, prisma } = world([
      oil(OilType.MINERAL, 2),
      oil(OilType.SYNTHETIC, 5),
    ]);

    const { data } = await service.preview(
      'industrial-oil',
      'synthetic-motor-oil',
    );
    expect(codesOf(data.blockers)).toContain('OIL_TYPE_CONFLICT');
    expect(data.canTransfer).toBe(false);

    await expect(
      service.transfer('industrial-oil', {
        targetCategoryId: 'synthetic-motor-oil',
        reason: 'Refile',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.catalogPart.updateMany).not.toHaveBeenCalled();
  });

  it('the `motor-oil` parent cannot say which composition they are', async () => {
    const { service } = world([oil(OilType.SYNTHETIC)]);

    const { data } = await service.preview('synthetic-motor-oil', 'motor-oil');

    expect(codesOf(data.blockers)).toContain('OIL_COMPOSITION_REQUIRED');
  });

  it('never changes a kind: a spare part blocks a move onto a composition', async () => {
    const { service, prisma } = world([SPARE]);

    const { data } = await service.preview(
      'oil-and-fluids',
      'synthetic-motor-oil',
    );
    expect(codesOf(data.blockers)).toContain('KIND_MISMATCH');

    await expect(
      service.transfer('oil-and-fluids', {
        targetCategoryId: 'synthetic-motor-oil',
        reason: 'Refile',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.catalogPart.updateMany).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('nor an oil onto a brake category', async () => {
    const { service } = world([oil(OilType.MINERAL)]);
    const { data } = await service.preview('mineral-motor-oil', 'brakes');
    expect(codesOf(data.blockers)).toContain('KIND_MISMATCH');
  });

  it('writes no oil type at all on a move of ordinary parts', async () => {
    const { service, prisma } = world([SPARE]);

    await service.transfer('brakes', {
      targetCategoryId: 'brake-discs',
      reason: 'Refile',
    } as never);

    expect(
      prisma.catalogPart.updateMany.mock.calls[0][0].data,
    ).not.toHaveProperty('oilType');
    expect(prisma.product.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      'oilType',
    );
  });
});

describe('AdminCategoryTransferService — fiscal readiness', () => {
  it('warns when products payable today could not be paid for after the move', async () => {
    const tree = TREE.map((n) =>
      n.id === 'brakes'
        ? {
            ...n,
            ...confirmedCategory({
              id: 'brakes',
              parentId: 'brake-system',
              packageCodeSet: null,
            }),
          }
        : n,
    );
    const { service } = world([SPARE], tree);

    const { data } = await service.preview('brakes', 'brake-discs');

    expect(codesOf(data.warnings)).toContain('TARGET_NOT_READY');
    expect(data.canTransfer).toBe(true);
  });

  it('says nothing about readiness when the source could not be paid for either', async () => {
    const { service } = world([SPARE]);
    const { data } = await service.preview('brakes', 'brake-discs');
    expect(codesOf(data.warnings)).not.toContain('TARGET_NOT_READY');
  });

  it('refuses a target with no codes when the source had them', async () => {
    const { service } = world([SPARE]);
    const { data } = await service.preview('brakes', 'oil-and-fluids');
    expect(codesOf(data.blockers)).toContain('TARGET_NOT_FISCALIZED');
  });

  describe('how the moved listings are sold', () => {
    const codes = (id: string, over: Record<string, string>) =>
      node(id, 'brake-system', {
        mxik: '08708005011000000',
        packageCodeSingle: '1417722',
        ...over,
      });
    const TREE_WITH_CODES = [
      codes('single-only', {}),
      codes('with-set', { packageCodeSet: '1417723' }),
      node('brake-system', null, { _count: { children: 2 } }),
    ];
    const previewWith = async (
      forms: { packageForm: PackageForm | null; count: number }[],
      target: string,
    ) => {
      const { prisma, service } = world([SPARE], TREE_WITH_CODES);
      const byKind = prisma.product.groupBy.getMockImplementation()!;
      prisma.product.groupBy.mockImplementation((args: { by: string[] }) =>
        args.by.includes('packageForm')
          ? Promise.resolve(
              forms.map((f) => ({
                packageForm: f.packageForm,
                _count: { _all: f.count },
              })),
            )
          : byKind(args),
      );
      const source = target === 'single-only' ? 'with-set' : 'single-only';
      return (await service.preview(source, target)).data;
    };

    it('warns that a set has no code on a target without one, not that it becomes a piece', async () => {
      const data = await previewWith(
        [{ packageForm: PackageForm.SET, count: 3 }],
        'single-only',
      );
      const warning = data.warnings.find(
        (w: { code: string }) => w.code === 'SALE_FORM_UNAVAILABLE',
      );
      expect(warning?.message).toContain('3 listing(s)');
    });

    it('warns about listings that state nothing on a target holding several codes', async () => {
      const data = await previewWith(
        [{ packageForm: null, count: 2 }],
        'with-set',
      );
      expect(codesOf(data.warnings)).toContain('SALE_FORM_UNAVAILABLE');
    });

    it('is quiet when every listing keeps a code', async () => {
      const data = await previewWith(
        [
          { packageForm: PackageForm.SET, count: 1 },
          { packageForm: PackageForm.SINGLE, count: 1 },
        ],
        'with-set',
      );
      expect(codesOf(data.warnings)).not.toContain('SALE_FORM_UNAVAILABLE');
    });
  });

  it('counts a composition as having codes: they come from the oil table', async () => {
    const { service } = world([oil(OilType.MINERAL)]);
    const { data } = await service.preview(
      'mineral-motor-oil',
      'synthetic-motor-oil',
    );
    expect(codesOf(data.blockers)).not.toContain('TARGET_NOT_FISCALIZED');
  });
});
