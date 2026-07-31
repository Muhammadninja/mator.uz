// Category ids end-to-end through the seller pipeline: the bot loads the tree
// from the backend (never a hardcoded list), the draft stores IDs, and commit
// copies those IDs onto the Product — re-validating the lineage server-side so a
// forged or since-moved pair can never be persisted.

import { Decimal } from '@prisma/client/runtime/library';
import { BadRequestException } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { WizardSessionStore, WizardStep } from './product-wizard';

// The private methods under test are reached through an index signature: these
// are unit tests of TelegramService's own internals, exercised exactly as the
// sibling draft-flow specs do, without widening the production API.
type AnyService = Record<string, any>;

function makeService(over: Partial<Record<string, unknown>> = {}): AnyService {
  const svc = Object.create(TelegramService.prototype) as AnyService;
  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    wizard: new WizardSessionStore(),
    categories: {
      findRootCategories: jest.fn().mockResolvedValue([
        { id: 'brake-system', name: 'Brake System' },
        { id: 'engine-system', name: 'Engine' },
      ]),
      findChildren: jest.fn().mockResolvedValue([]),
      validateCategorySelection: jest.fn().mockResolvedValue(undefined),
    },
    ...over,
  });
  return svc;
}

describe('loadCategoryOptions (the bot reads the tree, never a hardcoded list)', () => {
  it('loads ROOT categories and attaches their legacy enum mirrors', async () => {
    const svc: AnyService = makeService();
    const options = await svc.loadCategoryOptions(null);

    expect(svc.categories.findRootCategories).toHaveBeenCalled();
    expect(options).toEqual([
      {
        id: 'brake-system',
        name: 'Brake System',
        vehicleCategoryEnum: 'BRAKE_SYSTEM',
        mainCategoryEnum: null,
      },
      {
        // PartVehicleCategory.ENGINE's root is 'engine-system' — 'engine' is the
        // level-1 main category. The mapping, not the name, resolves this.
        id: 'engine-system',
        name: 'Engine',
        vehicleCategoryEnum: 'ENGINE',
        mainCategoryEnum: null,
      },
    ]);
  });

  it("loads a category's children and mirrors their main-category enums", async () => {
    const svc: AnyService = makeService();
    svc.categories.findChildren.mockResolvedValue([
      { id: 'brakes', name: 'Brakes' },
    ]);
    const options = await svc.loadCategoryOptions('brake-system');

    expect(svc.categories.findChildren).toHaveBeenCalledWith('brake-system');
    expect(options[0]).toMatchObject({
      id: 'brakes',
      mainCategoryEnum: 'BRAKES',
    });
  });

  it('surfaces an admin-created category with NO enum mirror', async () => {
    const svc: AnyService = makeService();
    svc.categories.findChildren.mockResolvedValue([
      { id: 'brake-pads', name: 'Тормозные колодки' },
    ]);
    const [option] = await svc.loadCategoryOptions('brakes');
    expect(option).toMatchObject({
      id: 'brake-pads',
      vehicleCategoryEnum: null,
      mainCategoryEnum: null,
    });
  });

  it('degrades to an empty list (not a crash) when the tree cannot be loaded', async () => {
    // A category-load failure must not kill the seller's dialogue mid-flow.
    const svc: AnyService = makeService();
    svc.categories.findRootCategories.mockRejectedValue(
      new Error('redis down'),
    );
    await expect(svc.loadCategoryOptions(null)).resolves.toEqual([]);
  });
});

describe('ensureCategoryOptions', () => {
  it('loads the roots when the session stands on the CATEGORY step', async () => {
    const svc: AnyService = makeService();
    const session = svc.wizard.start(1);
    session.step = WizardStep.CATEGORY;

    await svc.ensureCategoryOptions(session);

    expect(session.categoryOptions.map((o: { id: string }) => o.id)).toEqual([
      'brake-system',
      'engine-system',
    ]);
  });

  it('does nothing on any other step', async () => {
    const svc: AnyService = makeService();
    const session = svc.wizard.start(1);
    session.step = WizardStep.TITLE;

    await svc.ensureCategoryOptions(session);

    expect(svc.categories.findRootCategories).not.toHaveBeenCalled();
    expect(session.categoryOptions).toEqual([]);
  });
});

// A category button lives in the seller's chat indefinitely. Between the render
// and the tap the admin may deactivate, move, re-parent or delete the category,
// so the tapped id is re-checked against the LIVE tree — the session's option
// list is only a snapshot of what was rendered.
describe('isSelectableCategory (stale-callback guard)', () => {
  const live = (over: Record<string, unknown> = {}) => ({
    id: 'brakes',
    parentId: 'brake-system',
    level: 1,
    isActive: true,
    ...over,
  });

  function svcWith(found: Record<string, unknown> | null): AnyService {
    const svc: AnyService = makeService();
    svc.categories.findById = jest.fn().mockResolvedValue(found);
    return svc;
  }

  it('accepts a category that is active and still under the expected parent', async () => {
    const svc = svcWith(live());
    await expect(
      svc.isSelectableCategory('brakes', 'brake-system'),
    ).resolves.toBe(true);
  });

  it('rejects a category DEACTIVATED after the keyboard was sent', async () => {
    const svc = svcWith(live({ isActive: false }));
    await expect(
      svc.isSelectableCategory('brakes', 'brake-system'),
    ).resolves.toBe(false);
  });

  it('rejects a category MOVED under a different parent', async () => {
    const svc = svcWith(live({ parentId: 'maintenance-and-fluids' }));
    await expect(
      svc.isSelectableCategory('brakes', 'brake-system'),
    ).resolves.toBe(false);
  });

  it('rejects a category RE-PARENTED to root when a parent was expected', async () => {
    const svc = svcWith(live({ parentId: null, level: 0 }));
    await expect(
      svc.isSelectableCategory('brakes', 'brake-system'),
    ).resolves.toBe(false);
  });

  it('rejects a DELETED category', async () => {
    const svc = svcWith(null);
    await expect(
      svc.isSelectableCategory('brakes', 'brake-system'),
    ).resolves.toBe(false);
  });

  it('rejects a non-root id at the ROOT step', async () => {
    // The root step passes expectedParent=null, so a level-1 category tapped
    // from a stale keyboard cannot masquerade as a vehicle category.
    const svc = svcWith(live());
    await expect(svc.isSelectableCategory('brakes', null)).resolves.toBe(false);
  });

  it('accepts a genuine root at the ROOT step', async () => {
    const svc = svcWith(live({ id: 'brake-system', parentId: null, level: 0 }));
    await expect(svc.isSelectableCategory('brake-system', null)).resolves.toBe(
      true,
    );
  });

  it('rejects (never silently accepts) when the lookup itself fails', async () => {
    const svc: AnyService = makeService();
    svc.categories.findById = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(
      svc.isSelectableCategory('brakes', 'brake-system'),
    ).resolves.toBe(false);
  });

  it('a valid, active category from ANOTHER parent is still rejected', async () => {
    // The §3 case: the id is real and active, but belongs to a different branch
    // than the one the seller is standing on.
    const svc = svcWith(
      live({ id: 'oil-filters', parentId: 'maintenance-and-fluids' }),
    );
    await expect(
      svc.isSelectableCategory('oil-filters', 'brake-system'),
    ).resolves.toBe(false);
  });
});

describe('commit: draft category IDs → Product', () => {
  /** A READY_FOR_PREVIEW draft carrying dynamic category ids. */
  const readyDraft = (over: Record<string, unknown> = {}) => ({
    id: 'draft_1',
    sellerId: 1,
    status: 'READY_FOR_PREVIEW',
    version: 3,
    kind: 'SPARE_PART',
    title: 'Колодки тормозные',
    description: null,
    brand: 'Chevrolet',
    model: 'Nexia',
    category: 'BRAKE_SYSTEM',
    subcategory: 'BRAKES',
    vehicleCategoryId: 'brake-system',
    categoryId: 'brake-pads',
    partNumber: '96535062',
    partNumberType: 'UNKNOWN',
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    priceUzs: new Decimal(250000),
    formStep: 'QUESTIONNAIRE_DONE',
    images: [
      {
        status: 'READY',
        processedUrl: 'https://cdn/p0.jpg',
        processedPublicId: 'proc_0',
        sortOrder: 0,
      },
    ],
    ...over,
  });

  const prismaStub = () => ({
    product: { upsert: jest.fn().mockResolvedValue({ id: 10 }) },
    productImage: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    stock: { upsert: jest.fn().mockResolvedValue({ id: 20 }) },
    partModel: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({ id: 30 }),
    },
    brand: { upsert: jest.fn().mockResolvedValue({ id: 40 }) },
    carModel: { upsert: jest.fn().mockResolvedValue({ id: 50 }) },
  });

  function commitService(draft: Record<string, unknown>) {
    return makeService({
      prisma: prismaStub(),
      pending: new Map(),
      sessionExpiry: new Map(),
      drafts: {
        findAwaitingPreview: jest.fn().mockResolvedValue(draft),
        tryTransition: jest.fn().mockResolvedValue(true),
        publishDraft: jest.fn().mockResolvedValue(true),
        collectOriginalPublicIds: jest.fn().mockResolvedValue([]),
      },
      catalogProjection: {
        projectStock: jest.fn().mockResolvedValue(undefined),
      },
      telemetry: { event: jest.fn(), metric: jest.fn() },
      cloudinary: { deleteAssets: jest.fn().mockResolvedValue(undefined) },
      clearSessionExpiry: jest.fn(),
      sellers: {
        findByTgId: jest.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
      },
      // Pass-through mutex: these tests are about the category branch, not the
      // double-tap guard (covered in telegram.draft-locks.spec.ts).
      locks: {
        withDraftLock: jest.fn(
          async (_key: string, fn: () => Promise<unknown>) => fn(),
        ),
        run: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
      },
      queue: { removeImageJob: jest.fn().mockResolvedValue(undefined) },
      bot: {
        telegram: { sendMessage: jest.fn().mockResolvedValue(undefined) },
      },
    });
  }

  const ctx = () => ({ reply: jest.fn().mockResolvedValue(undefined) });

  it('copies BOTH ids from the draft onto the Product', async () => {
    const svc = commitService(readyDraft());

    await svc.commitPending(ctx(), 7);

    expect(svc.categories.validateCategorySelection).toHaveBeenCalledWith(
      'brake-system',
      'brake-pads',
    );
    const { create } = svc.prisma.product.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      vehicleCategoryId: 'brake-system',
      categoryId: 'brake-pads',
    });
  });

  it('drops an INVALID pair rather than persisting it (the §26 backstop)', async () => {
    // The guarantee must hold for any caller — a forged callback, or a category
    // the admin moved between the seller's pick and the commit.
    const svc = commitService(readyDraft({ categoryId: 'oil-filters' }));
    svc.categories.validateCategorySelection.mockRejectedValue(
      new BadRequestException('does not belong'),
    );

    await svc.commitPending(ctx(), 7);

    const { create } = svc.prisma.product.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      vehicleCategoryId: null,
      categoryId: null,
    });
    // The listing still commits (with its legacy enum taxonomy) — an admin's
    // edit must never strand a seller mid-flow.
    expect(svc.prisma.product.upsert).toHaveBeenCalled();
  });

  it('drops the LEGACY ENUM MIRRORS too when the pair is rejected', async () => {
    // The mirrors are exactly the values that just failed validation, so writing
    // them would leave a Product whose enum taxonomy contradicts its null ids.
    // A NEUTRAL title, so the keyword classifier infers nothing about brakes —
    // any BRAKES/BRAKE_SYSTEM on the product could then only have come from the
    // stale draft mirror, which is what this test is about.
    const svc = commitService(
      readyDraft({
        title: 'Деталь для автомобиля',
        category: 'BRAKE_SYSTEM',
        subcategory: 'BRAKES',
        categoryId: 'oil-filters',
      }),
    );
    svc.categories.validateCategorySelection.mockRejectedValue(
      new BadRequestException('does not belong'),
    );

    await svc.commitPending(ctx(), 7);

    const { create } = svc.prisma.product.upsert.mock.calls[0][0];
    expect(create.vehicleCategoryId).toBeNull();
    expect(create.categoryId).toBeNull();
    // The stale mirrors must NOT survive onto the product.
    expect(create.vehicleCategory).toBeNull();
    expect(create.mainCategory).not.toBe('BRAKES');
  });

  it('re-derives the enum mirrors from the VALIDATED ids, not the draft', async () => {
    // A draft whose stored enum disagrees with its id (e.g. the admin moved the
    // category after the pick) must be written from the id, which is the source
    // of truth — never from the drifted mirror.
    const svc = commitService(
      readyDraft({
        vehicleCategoryId: 'engine-system',
        categoryId: 'engine',
        category: 'BRAKE_SYSTEM', // drifted/stale
        subcategory: 'BRAKES', // drifted/stale
      }),
    );

    await svc.commitPending(ctx(), 7);

    const { create } = svc.prisma.product.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      vehicleCategoryId: 'engine-system',
      categoryId: 'engine',
      vehicleCategory: 'ENGINE', // re-derived, NOT the drifted BRAKE_SYSTEM
      mainCategory: 'ENGINE',
    });
  });

  it('an admin-created category commits with ids and NO invented enum mirror', async () => {
    // Neutral title again, so the classifier contributes no mainCategory of its
    // own and the assertion isolates the mirror behaviour.
    const svc = commitService(
      readyDraft({
        title: 'Деталь для автомобиля',
        vehicleCategoryId: 'brake-system',
        categoryId: 'brake-hardware', // mirrors no PartMainCategory
        subcategory: null,
      }),
    );

    await svc.commitPending(ctx(), 7);

    const { create } = svc.prisma.product.upsert.mock.calls[0][0];
    expect(create).toMatchObject({
      vehicleCategoryId: 'brake-system',
      categoryId: 'brake-hardware',
      // The ROOT still mirrors an enum, so that one is written…
      vehicleCategory: 'BRAKE_SYSTEM',
    });
    // …but the leaf has no enum equivalent, so no mirror is invented for it.
    expect(create.mainCategory).not.toBe('BRAKES');
  });

  it('commits a MOTOR_OIL with no category ids and no validation call', async () => {
    // An oil's taxonomy follows from its kind, so there is no pair to check.
    const svc = commitService(
      readyDraft({
        kind: 'MOTOR_OIL',
        brand: null,
        model: null,
        category: null,
        subcategory: null,
        vehicleCategoryId: null,
        categoryId: null,
        partNumber: null,
        oilViscosity: '5W-30',
        oilType: 'SYNTHETIC',
        oilVolumeMl: 4000,
      }),
    );

    await svc.commitPending(ctx(), 7);

    expect(svc.categories.validateCategorySelection).not.toHaveBeenCalled();
    const { create } = svc.prisma.product.upsert.mock.calls[0][0];
    expect(create).toMatchObject({ vehicleCategoryId: null, categoryId: null });
  });
});
