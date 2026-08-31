// Regression: "Другое" → "Моторное масло" → an oil category.
//
// The bug this pins down was NOT in the category tree and NOT in the wizard's
// pure transitions — both were correct, which is why every existing spec passed
// while the flow was broken in production. It lived in the seam BETWEEN them:
// the OTHER_CATEGORY menu was RENDERED from the children of `motor-oil`, while
// the handler for a tap on one of those buttons re-validated it against a
// hardcoded `other` parent. Every correctly-listed oil category therefore came
// back "Эта категория больше недоступна…".
//
// So these tests drive the REGISTERED Telegraf handlers against a live-tree stub
// — the only layer where the two sides meet. Asserting on `selectOtherCategory`
// alone cannot see this class of bug.

import { OilType, ProductKind } from '@prisma/client';
import { TelegramService } from './telegram.service';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  beginQuestionnaire,
  CATALOG_VERSION,
  selectBrand,
  selectOtherBrand,
  otherCategoryParentId,
  stepPrompt,
  STALE_CATEGORY_MESSAGE,
} from './product-wizard';
import {
  CategoryAnchor,
  MOTOR_OIL_CATEGORY_IDS,
} from '../catalog/categories/category-map';
import { WIZARD_BRANDS } from './wizard-catalog';

type AnyService = Record<string, any>;

// ── The live tree, as the backend would answer it ───────────────────────────
// The four options under "Моторное масло" are children of `motor-oil` (see
// subcategory-taxonomy.seed.ts) — NOT of `other`, which is the admin-managed
// catalogue of unrelated goods. That asymmetry is the whole bug.
const OIL_CATEGORY_NAMES: Readonly<Record<string, string>> = {
  [CategoryAnchor.SYNTHETIC_MOTOR_OIL]: 'Синтетическое моторное масло',
  [CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL]: 'Полусинтетическое моторное масло',
  [CategoryAnchor.MINERAL_MOTOR_OIL]: 'Минеральное моторное масло',
  [CategoryAnchor.TRANSMISSION_OIL]: 'Трансмиссионное масло',
};

/** Every category row the stubbed tree knows, keyed by id. */
const TREE: Record<string, Record<string, unknown>> = {
  [CategoryAnchor.MOTOR_OIL]: {
    id: CategoryAnchor.MOTOR_OIL,
    name: 'Моторные масла',
    parentId: 'maintenance-and-fluids',
    level: 1,
    isActive: true,
    mxik: null,
    packageCodeSingle: null,
    packageCodeSet: null,
  },
  ...Object.fromEntries(
    MOTOR_OIL_CATEGORY_IDS.map((id) => [
      id,
      {
        id,
        name: OIL_CATEGORY_NAMES[id],
        parentId: CategoryAnchor.MOTOR_OIL,
        level: 2,
        isActive: true,
        mxik: '02710005001000000',
        packageCodeSingle: '1282037',
        packageCodeSet: null,
      },
    ]),
  ),
  // The `other` catalogue: real, active, but a DIFFERENT subtree.
  'wiper-blades': {
    id: 'wiper-blades',
    name: 'Щетки стеклоочистителя',
    parentId: CategoryAnchor.OTHER,
    level: 2,
    isActive: true,
    mxik: null,
    packageCodeSingle: null,
    packageCodeSet: null,
  },
};

const CHILDREN: Record<string, string[]> = {
  [CategoryAnchor.MOTOR_OIL]: [...MOTOR_OIL_CATEGORY_IDS],
  [CategoryAnchor.OTHER]: ['wiper-blades'],
};

/**
 * A TelegramService whose handlers are registered against a fake bot, so a tap
 * can be dispatched by its callback_data exactly as Telegraf would.
 */
function makeBotService(): {
  svc: AnyService;
  tap: (data: string, tgUserId?: number) => Promise<void>;
  replies: string[];
} {
  const svc = Object.create(TelegramService.prototype) as AnyService;
  const handlers: { match: RegExp | string; fn: (ctx: any) => Promise<void> }[] =
    [];
  const replies: string[] = [];

  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    wizard: new WizardSessionStore(),
    langCache: new Map<number, 'ru' | 'uz' | 'en'>([[1, 'ru']]),
    // Dedup window for the stale-catalog notice; the prototype-cast bypasses
    // the field initializer, so provide a real Map.
    staleNoticeSentAt: new Map<number, number>(),
    sellers: { findByTgId: jest.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }) },
    offerFlow: { registerActions: jest.fn(), clear: jest.fn() },
    bot: {
      action: (match: RegExp | string, fn: (ctx: any) => Promise<void>) =>
        handlers.push({ match, fn }),
      start: () => {},
      command: () => {},
      on: () => {},
      telegram: { sendMessage: jest.fn() },
    },
    categories: {
      findById: jest.fn(async (id: string) => TREE[id] ?? null),
      findChildren: jest.fn(async (parentId: string) =>
        (CHILDREN[parentId] ?? []).map((id) => TREE[id]),
      ),
      findRootCategories: jest.fn().mockResolvedValue([]),
      validateCategorySelection: jest.fn().mockResolvedValue(undefined),
    },
    // The draft/persistence side is out of scope here: the assertions are about
    // which step the session lands on and what the seller is told.
    removeInlineKeyboard: jest.fn(),
    handleFormAdvance: jest.fn(),
  });

  svc.registerHandlers();

  async function tap(data: string, tgUserId = 1): Promise<void> {
    const entry = handlers.find(({ match }) =>
      match instanceof RegExp ? match.test(data) : match === data,
    );
    if (!entry) throw new Error(`no handler registered for "${data}"`);
    const m =
      entry.match instanceof RegExp ? entry.match.exec(data) : [data];
    const ctx = {
      match: m,
      from: { id: tgUserId },
      answerCbQuery: jest.fn(),
      reply: jest.fn(async (text: string) => {
        replies.push(text);
      }),
    };
    await entry.fn(ctx);
  }

  return { svc, tap, replies };
}

/** A session standing at BRAND, the branch point where "Другое" is offered. */
function seatSession(svc: AnyService, tgUserId = 1): WizardSession {
  const session = svc.wizard.start(tgUserId);
  beginQuestionnaire(session);
  return session;
}

/** callback_data builders, mirroring what the keyboards emit. */
const V = CATALOG_VERSION;
const ocData = (id: string) => `wiz:${V}:oc:${id}`;
const okData = (wire: string) => `wiz:${V}:ok:${wire}`;
const cData = (id: string) => `wiz:${V}:c:${id}`;
const scData = (id: string) => `wiz:${V}:sc:${id}`;

describe('"Другое" → "Моторное масло" → oil category (regression)', () => {
  // 1. Reaching the oil menu at all.
  it('"Другое" → "Моторное масло" lands on OTHER_CATEGORY as MOTOR_OIL', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);

    selectOtherBrand(session);
    expect(session.step).toBe(WizardStep.OTHER_KIND);

    await tap(okData('motor_oil'));
    expect(session.kind).toBe(ProductKind.MOTOR_OIL);
    expect(session.step).toBe(WizardStep.OTHER_CATEGORY);
  });

  // 2. The menu shows every oil type, and shows them from the RIGHT subtree.
  it('renders all four oil categories, as children of `motor-oil`', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);
    selectOtherBrand(session);
    await tap(okData('motor_oil'));

    await svc.ensureCategoryOptions(session);

    expect(session.categoryOptionsParentId).toBe(CategoryAnchor.MOTOR_OIL);
    expect(session.categoryOptions.map((c: any) => c.id)).toEqual([
      ...MOTOR_OIL_CATEGORY_IDS,
    ]);

    // …and each one gets a button carrying its own id.
    const keyboard = stepPrompt(session).keyboard;
    expect(keyboard).toBeDefined();
    const rows = keyboard!.reply_markup.inline_keyboard;
    const payloads = rows
      .flat()
      .map((b: any) => b.callback_data)
      .filter((d: string) => d.includes(':oc:'));
    expect(payloads).toEqual(MOTOR_OIL_CATEGORY_IDS.map(ocData));
  });

  // 3 + 4 + 5. Tapping each type is accepted, advances, and says nothing about
  // the category being unavailable. This is the exact failure that was reported.
  it.each([...MOTOR_OIL_CATEGORY_IDS])(
    'accepts a tap on "%s" and moves on (no stale-category notice)',
    async (categoryId) => {
      const { svc, tap, replies } = makeBotService();
      const session = seatSession(svc);
      selectOtherBrand(session);
      await tap(okData('motor_oil'));
      await svc.ensureCategoryOptions(session);

      await tap(ocData(categoryId));

      expect(replies).not.toContain(STALE_CATEGORY_MESSAGE);
      expect(session.categoryId).toBe(categoryId);
      expect(session.vehicleCategoryId).toBe(CategoryAnchor.MOTOR_OIL);
      // The step moved OFF the category question — the seller is being asked
      // the next oil question instead of the same one again.
      expect(session.step).not.toBe(WizardStep.OTHER_CATEGORY);
      expect(session.step).toBe(WizardStep.OIL_VISCOSITY);
    },
  );

  // The composition is DERIVED from the category, never asked separately.
  it('derives oilType from the chosen composition (and leaves it unset for transmission oil)', async () => {
    const cases: [string, OilType | null][] = [
      [CategoryAnchor.SYNTHETIC_MOTOR_OIL, OilType.SYNTHETIC],
      [CategoryAnchor.SEMI_SYNTHETIC_MOTOR_OIL, OilType.SEMI_SYNTHETIC],
      [CategoryAnchor.MINERAL_MOTOR_OIL, OilType.MINERAL],
      [CategoryAnchor.TRANSMISSION_OIL, null],
    ];
    for (const [categoryId, expected] of cases) {
      const { svc, tap } = makeBotService();
      const session = seatSession(svc);
      selectOtherBrand(session);
      await tap(okData('motor_oil'));
      await svc.ensureCategoryOptions(session);
      await tap(ocData(categoryId));
      expect(session.oilType).toBe(expected);
    }
  });

  // The guard itself must still bite — the fix widened the accepted parent to
  // the level actually rendered, it did not remove the check.
  it('still rejects an `other`-subtree category tapped on the OIL menu', async () => {
    const { svc, tap, replies } = makeBotService();
    const session = seatSession(svc);
    selectOtherBrand(session);
    await tap(okData('motor_oil'));
    await svc.ensureCategoryOptions(session);

    // Real and active, but it hangs under `other`, not under `motor-oil`.
    await tap(ocData('wiper-blades'));

    expect(replies).toContain(STALE_CATEGORY_MESSAGE);
    expect(session.categoryId).toBeNull();
    expect(session.step).toBe(WizardStep.OTHER_CATEGORY);
  });

  it('still rejects an oil category DEACTIVATED after the keyboard was sent', async () => {
    const { svc, tap, replies } = makeBotService();
    const session = seatSession(svc);
    selectOtherBrand(session);
    await tap(okData('motor_oil'));
    await svc.ensureCategoryOptions(session);

    svc.categories.findById = jest.fn(async (id: string) =>
      id === CategoryAnchor.SYNTHETIC_MOTOR_OIL
        ? { ...TREE[id], isActive: false }
        : (TREE[id] ?? null),
    );
    await tap(ocData(CategoryAnchor.SYNTHETIC_MOTOR_OIL));

    expect(replies).toContain(STALE_CATEGORY_MESSAGE);
    expect(session.step).toBe(WizardStep.OTHER_CATEGORY);
  });

  // The root cause, stated directly: render and validate must agree on WHOSE
  // children the menu is showing.
  it('validates a tap against the SAME parent the menu was rendered from', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);
    selectOtherBrand(session);
    await tap(okData('motor_oil'));
    await svc.ensureCategoryOptions(session);

    expect(session.categoryOptionsParentId).toBe(otherCategoryParentId(session));
  });
});

// The vehicle path must be untouched by the fix: it is the flow that always
// worked, and it reaches its categories through DIFFERENT handlers (`c:`/`sc:`).
describe('vehicle path (unchanged)', () => {
  const VEHICLE_TREE: Record<string, Record<string, unknown>> = {
    'brake-system': {
      id: 'brake-system',
      name: 'Тормозная система',
      parentId: null,
      level: 0,
      isActive: true,
      mxik: null,
      packageCodeSingle: null,
      packageCodeSet: null,
    },
    'brake-pads': {
      id: 'brake-pads',
      name: 'Тормозные колодки',
      parentId: 'brake-system',
      level: 1,
      isActive: true,
      mxik: null,
      packageCodeSingle: null,
      packageCodeSet: null,
    },
  };

  function vehicleService() {
    const { svc, tap, replies } = makeBotService();
    svc.categories.findById = jest.fn(
      async (id: string) => VEHICLE_TREE[id] ?? TREE[id] ?? null,
    );
    svc.categories.findChildren = jest.fn(async (parentId: string) =>
      parentId === 'brake-system' ? [VEHICLE_TREE['brake-pads']] : [],
    );
    svc.categories.findRootCategories = jest
      .fn()
      .mockResolvedValue([VEHICLE_TREE['brake-system']]);
    return { svc, tap, replies };
  }

  it('brand → model → category → subcategory still works end to end', async () => {
    const { svc, tap, replies } = vehicleService();
    const session = seatSession(svc);

    selectBrand(session, 0);
    await tap(`wiz:${V}:m:0`);
    expect(session.brand).toBe(WIZARD_BRANDS[0].name);
    expect(session.step).toBe(WizardStep.CATEGORY);

    await svc.ensureCategoryOptions(session);
    expect(session.categoryOptionsParentId).toBeNull();

    await tap(cData('brake-system'));
    expect(replies).not.toContain(STALE_CATEGORY_MESSAGE);
    expect(session.categoryId).toBe('brake-system');
    expect(session.step).toBe(WizardStep.SUBCATEGORY);

    await tap(scData('brake-pads'));
    expect(replies).not.toContain(STALE_CATEGORY_MESSAGE);
    expect(session.categoryId).toBe('brake-pads');
    expect(session.step).not.toBe(WizardStep.SUBCATEGORY);
    expect(session.kind).toBe(ProductKind.SPARE_PART);
  });

  it('the ROOT category step still validates against the root level (null parent)', async () => {
    const { svc, tap, replies } = vehicleService();
    const session = seatSession(svc);
    selectBrand(session, 0);
    await tap(`wiz:${V}:m:0`);
    await svc.ensureCategoryOptions(session);

    // A level-1 category tapped at the ROOT step is still rejected.
    await tap(cData('brake-pads'));
    expect(replies).toContain(STALE_CATEGORY_MESSAGE);
    expect(session.step).toBe(WizardStep.CATEGORY);
  });
});
