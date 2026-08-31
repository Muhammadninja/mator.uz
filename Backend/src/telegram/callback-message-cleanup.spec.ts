// Regression: the chat must hold only the LIVE wizard screen.
//
// Every wizard question is answered exactly once, so once a button is tapped
// and the choice sticks, the screen carrying it is spent. Leaving those screens
// behind turned a listing into a scroll of dead keyboards the seller could
// still tap. The message that carried the pressed button is therefore deleted —
// but ONLY after the transition succeeded, because the alternative (deleting on
// receipt) takes the seller's current screen away whenever the tap turns out to
// be stale.
//
// These tests drive the REGISTERED Telegraf handlers with the REAL
// `consumeCallbackMessage`, since the property under test — delete vs. keep,
// and in which order — lives in the seam between the handler and the Telegram
// API, not in the pure wizard transitions.

import { ProductKind } from '@prisma/client';
import { TelegramService } from './telegram.service';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  beginQuestionnaire,
  CATALOG_VERSION,
  selectBrand,
  selectOtherBrand,
  STALE_CATEGORY_MESSAGE,
  WIZ_BACK_ACTION,
} from './product-wizard';
import {
  CategoryAnchor,
  MOTOR_OIL_CATEGORY_IDS,
} from '../catalog/categories/category-map';

type AnyService = Record<string, any>;

/** What a single dispatched tap did to its own message. */
type TapRecord = {
  deleted: boolean;
  keyboardStripped: boolean;
  /** Call order, so "delete happened after the reply" can be caught. */
  order: string[];
};

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
        name: 'Масло',
        parentId: CategoryAnchor.MOTOR_OIL,
        level: 2,
        isActive: true,
        mxik: '02710005001000000',
        packageCodeSingle: '1282037',
        packageCodeSet: null,
      },
    ]),
  ),
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
  // Real and active, but under `other` — the stale-tap fixture.
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
  'brake-system': ['brake-pads'],
};

/**
 * A TelegramService with the real message-cleanup helpers wired in, so a tap
 * can be dispatched by callback_data and what it did to its own message read
 * back. `deleteBehaviour` lets a test make Telegram refuse the delete.
 */
function makeBotService(deleteBehaviour: 'ok' | 'throws' | 'absent' = 'ok'): {
  svc: AnyService;
  tap: (data: string, tgUserId?: number) => Promise<TapRecord>;
  replies: string[];
} {
  const svc = Object.create(TelegramService.prototype) as AnyService;
  const handlers: {
    match: RegExp | string;
    fn: (ctx: any) => Promise<void>;
  }[] = [];
  const replies: string[] = [];

  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    wizard: new WizardSessionStore(),
    langCache: new Map<number, 'ru' | 'uz' | 'en'>([[1, 'ru']]),
    staleNoticeSentAt: new Map<number, number>(),
    sellers: {
      findByTgId: jest.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }),
    },
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
      findRootCategories: jest.fn(async () => [TREE['brake-system']]),
      validateCategorySelection: jest.fn().mockResolvedValue(undefined),
    },
    // Persistence is out of scope: these assertions are about the message, the
    // step the session lands on, and what the seller is told.
    handleFormAdvance: jest.fn(),
  });

  svc.registerHandlers();

  async function tap(data: string, tgUserId = 1): Promise<TapRecord> {
    const entry = handlers.find(({ match }) =>
      match instanceof RegExp ? match.test(data) : match === data,
    );
    if (!entry) throw new Error(`no handler registered for "${data}"`);
    const m = entry.match instanceof RegExp ? entry.match.exec(data) : [data];

    const rec: TapRecord = {
      deleted: false,
      keyboardStripped: false,
      order: [],
    };
    const ctx: Record<string, unknown> = {
      match: m,
      from: { id: tgUserId },
      answerCbQuery: jest.fn(async () => {
        rec.order.push('answerCbQuery');
        return true;
      }),
      editMessageReplyMarkup: jest.fn(async () => {
        rec.order.push('editMessageReplyMarkup');
        rec.keyboardStripped = true;
        return {} as unknown;
      }),
      reply: jest.fn(async (text: string) => {
        rec.order.push('reply');
        replies.push(text);
        return {} as unknown;
      }),
    };
    if (deleteBehaviour !== 'absent') {
      ctx.deleteMessage = jest.fn(async () => {
        rec.order.push('deleteMessage');
        if (deleteBehaviour === 'throws') {
          // Shape of a real Telegram refusal.
          throw new Error(
            "400: Bad Request: message can't be deleted for everyone",
          );
        }
        rec.deleted = true;
        return true;
      });
    } else {
      // Telegraf throws when the update carries no message to act on (e.g. an
      // inline-mode callback) — the handler must survive it like any other
      // delete failure.
      ctx.deleteMessage = jest.fn(async () => {
        rec.order.push('deleteMessage');
        throw new TypeError(
          'Telegram: "message" property is required for this method',
        );
      });
    }
    await entry.fn(ctx);
    return rec;
  }

  return { svc, tap, replies };
}

function seatSession(svc: AnyService, tgUserId = 1): WizardSession {
  const session = svc.wizard.start(tgUserId);
  beginQuestionnaire(session);
  return session;
}

const V = CATALOG_VERSION;
const ocData = (id: string) => `wiz:${V}:oc:${id}`;
const okData = (wire: string) => `wiz:${V}:ok:${wire}`;
const cData = (id: string) => `wiz:${V}:c:${id}`;
const scData = (id: string) => `wiz:${V}:sc:${id}`;

describe('selection callbacks retire their own message', () => {
  it('deletes the answered screen and advances the step', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);

    selectBrand(session, 0);
    const rec = await tap(`wiz:${V}:m:0`);

    expect(rec.deleted).toBe(true);
    expect(session.step).toBe(WizardStep.CATEGORY);
    // Deleting REPLACES the keyboard strip on the happy path — one API call,
    // not both.
    expect(rec.keyboardStripped).toBe(false);
  });

  it('answers the callback BEFORE deleting, so Telegram never spins', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);
    selectBrand(session, 0);

    const rec = await tap(`wiz:${V}:m:0`);

    expect(rec.order[0]).toBe('answerCbQuery');
    expect(rec.order).toContain('deleteMessage');
    expect(rec.order.indexOf('answerCbQuery')).toBeLessThan(
      rec.order.indexOf('deleteMessage'),
    );
  });

  it('deletes only AFTER the transition is applied', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);
    selectBrand(session, 0);
    await tap(`wiz:${V}:m:0`);
    await svc.ensureCategoryOptions(session);

    // The step must already have moved by the time the delete goes out — the
    // ordering that makes a failed transition safe.
    let stepAtDelete: WizardStep | undefined;
    const spy = jest
      .spyOn(svc as any, 'consumeCallbackMessage')
      .mockImplementation(async () => {
        stepAtDelete = session.step;
      });

    await tap(cData('brake-system'));
    expect(stepAtDelete).toBe(WizardStep.SUBCATEGORY);
    spy.mockRestore();
  });

  it('carries the whole spare-part drill without leaving screens behind', async () => {
    const { svc, tap, replies } = makeBotService();
    const session = seatSession(svc);

    selectBrand(session, 0);
    expect((await tap(`wiz:${V}:m:0`)).deleted).toBe(true);

    await svc.ensureCategoryOptions(session);
    expect((await tap(cData('brake-system'))).deleted).toBe(true);
    expect(session.categoryId).toBe('brake-system');

    expect((await tap(scData('brake-pads'))).deleted).toBe(true);
    expect(session.categoryId).toBe('brake-pads');
    expect(session.kind).toBe(ProductKind.SPARE_PART);
    expect(replies).not.toContain(STALE_CATEGORY_MESSAGE);
  });
});

describe('delete failures never break the wizard', () => {
  it('continues the flow when Telegram refuses the delete', async () => {
    const { svc, tap } = makeBotService('throws');
    const session = seatSession(svc);
    selectBrand(session, 0);

    const rec = await tap(`wiz:${V}:m:0`);

    expect(rec.deleted).toBe(false);
    // Degraded, not dropped: the spent screen is at least made unclickable.
    expect(rec.keyboardStripped).toBe(true);
    // …and the state transition still stands.
    expect(session.step).toBe(WizardStep.CATEGORY);
    expect(session.brand).toBeTruthy();
  });

  it('survives a callback with no message to delete', async () => {
    const { svc, tap } = makeBotService('absent');
    const session = seatSession(svc);
    selectBrand(session, 0);

    await expect(tap(`wiz:${V}:m:0`)).resolves.toBeDefined();
    expect(session.step).toBe(WizardStep.CATEGORY);
  });

  it('still hands off to the next step after a failed delete', async () => {
    const { svc, tap } = makeBotService('throws');
    const session = seatSession(svc);
    selectBrand(session, 0);

    await tap(`wiz:${V}:m:0`);

    expect(svc.handleFormAdvance).toHaveBeenCalledTimes(1);
  });
});

describe('rejected taps keep the screen the seller is standing on', () => {
  it('does NOT delete when the category re-validation fails', async () => {
    const { svc, tap, replies } = makeBotService();
    const session = seatSession(svc);
    selectOtherBrand(session);
    await tap(okData('motor_oil'));
    await svc.ensureCategoryOptions(session);

    // Active, but from the `other` subtree — rejected on the OIL menu.
    const rec = await tap(ocData('wiper-blades'));

    expect(rec.deleted).toBe(false);
    expect(replies).toContain(STALE_CATEGORY_MESSAGE);
    expect(session.step).toBe(WizardStep.OTHER_CATEGORY);
    expect(session.categoryId).toBeNull();
  });

  it('does NOT delete when the transition rejects the tap as stale', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);
    selectBrand(session, 0);
    await tap(`wiz:${V}:m:0`);

    // A MODEL button re-tapped from a historic message: the session has long
    // moved past that step, so the transition returns 'stale'.
    const rec = await tap(`wiz:${V}:m:0`);

    expect(rec.deleted).toBe(false);
    expect(svc.handleFormAdvance).toHaveBeenCalledTimes(1); // not twice
  });

  it('does NOT delete a stale-catalog tap, and strips its keyboard instead', async () => {
    const { svc, tap, replies } = makeBotService();
    seatSession(svc);

    // A payload from an OUTDATED catalog version → the catch-all handler.
    const rec = await tap(`wiz:${V - 1}:c:brake-system`);

    expect(rec.deleted).toBe(false);
    expect(rec.keyboardStripped).toBe(true);
    expect(replies.some((r) => r.includes('Каталог был обновлён'))).toBe(true);
  });
});

// The recently-fixed "Другое" branch, checked specifically: cleanup is a UX
// layer and must not disturb which parent the menu validates against, where the
// oil taxonomy comes from, or what the transitions derive.
describe('"Другое" → Масла flow (cleanup is UX-only)', () => {
  it('deletes each answered screen while state and choices survive', async () => {
    const { svc, tap, replies } = makeBotService();
    const session = seatSession(svc);

    selectOtherBrand(session);
    expect(session.step).toBe(WizardStep.OTHER_KIND);

    // "Что продаёте?" → Моторное масло
    expect((await tap(okData('motor_oil'))).deleted).toBe(true);
    expect(session.kind).toBe(ProductKind.MOTOR_OIL);
    expect(session.step).toBe(WizardStep.OTHER_CATEGORY);

    await svc.ensureCategoryOptions(session);
    // Render/validate agreement is untouched by the delete.
    expect(session.categoryOptionsParentId).toBe(CategoryAnchor.MOTOR_OIL);

    // …→ a concrete oil type
    expect(
      (await tap(ocData(CategoryAnchor.SYNTHETIC_MOTOR_OIL))).deleted,
    ).toBe(true);
    expect(replies).not.toContain(STALE_CATEGORY_MESSAGE);
    expect(session.categoryId).toBe(CategoryAnchor.SYNTHETIC_MOTOR_OIL);
    expect(session.vehicleCategoryId).toBe(CategoryAnchor.MOTOR_OIL);
    expect(session.step).toBe(WizardStep.OIL_VISCOSITY);

    // The derived composition still comes through.
    expect(session.oilType).toBe('SYNTHETIC');
  });

  it.each([...MOTOR_OIL_CATEGORY_IDS])(
    'deletes the oil menu on a tap of "%s" and keeps the pick',
    async (categoryId) => {
      const { svc, tap } = makeBotService();
      const session = seatSession(svc);
      selectOtherBrand(session);
      await tap(okData('motor_oil'));
      await svc.ensureCategoryOptions(session);

      const rec = await tap(ocData(categoryId));

      expect(rec.deleted).toBe(true);
      expect(session.categoryId).toBe(categoryId);
    },
  );

  it('deletes on a viscosity pick, including the "custom" escape hatch', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);
    selectOtherBrand(session);
    await tap(okData('motor_oil'));
    await svc.ensureCategoryOptions(session);
    await tap(ocData(CategoryAnchor.SYNTHETIC_MOTOR_OIL));
    expect(session.step).toBe(WizardStep.OIL_VISCOSITY);

    const rec = await tap(`wiz:${V}:ov:custom`);
    expect(rec.deleted).toBe(true);
    expect(session.step).toBe(WizardStep.OIL_VISCOSITY_CUSTOM);
  });
});

describe('⬅️ Назад', () => {
  it('deletes the screen it was tapped on and steps back', async () => {
    const { svc, tap } = makeBotService();
    const session = seatSession(svc);
    selectBrand(session, 0);
    await tap(`wiz:${V}:m:0`);
    expect(session.step).toBe(WizardStep.CATEGORY);

    const rec = await tap(WIZ_BACK_ACTION);

    expect(rec.deleted).toBe(true);
    // Back only moves the pointer — the answered field is kept.
    expect(session.step).not.toBe(WizardStep.CATEGORY);
    expect(session.brand).toBeTruthy();
  });
});

// The terminal screens: the preview's confirm/cancel buttons and the /start
// resume prompt. Each ends or redirects the flow, so its screen is spent the
// moment the tap lands — and deleting it also closes the double-tap window the
// old keyboard-strip was there to close.
describe('preview and draft-prompt screens are retired on tap', () => {
  /** Stub out the side effects; the assertion is about the message. */
  function confirmService(): ReturnType<typeof makeBotService> {
    const made = makeBotService();
    Object.assign(made.svc, {
      commitPending: jest.fn(),
      cancelPendingDraft: jest.fn(),
      reopenDraftForEdit: jest.fn(),
      replaceDraftPhotos: jest.fn(),
      resumeDraft: jest.fn(),
      retryFailedImages: jest.fn(),
      cancelActiveDraft: jest.fn(),
      startProductCreation: jest.fn(),
      drafts: { findImagesInFlight: jest.fn().mockResolvedValue(null) },
    });
    return made;
  }

  it.each([
    ['product:add', 'commitPending'],
    ['product:cancel', 'cancelPendingDraft'],
    ['product:back', 'reopenDraftForEdit'],
    ['product:change_photos', 'replaceDraftPhotos'],
    ['draft:resume', 'resumeDraft'],
    ['draft:retry_images', 'retryFailedImages'],
    ['draft:cancel', 'cancelActiveDraft'],
  ])('%s deletes its screen and still runs %s', async (data, effect) => {
    const { svc, tap } = confirmService();
    seatSession(svc);

    const rec = await tap(data);

    expect(rec.deleted).toBe(true);
    expect(svc[effect]).toHaveBeenCalledTimes(1);
  });

  it('answers the callback before deleting the preview', async () => {
    const { svc, tap } = confirmService();
    seatSession(svc);

    const rec = await tap('product:add');

    expect(rec.order.indexOf('answerCbQuery')).toBeLessThan(
      rec.order.indexOf('deleteMessage'),
    );
  });

  it('a refused delete still commits the listing', async () => {
    const made = makeBotService('throws');
    Object.assign(made.svc, { commitPending: jest.fn() });
    seatSession(made.svc);

    const rec = await made.tap('product:add');

    expect(rec.deleted).toBe(false);
    expect(rec.keyboardStripped).toBe(true);
    expect(made.svc.commitPending).toHaveBeenCalledTimes(1);
  });

  it('draft:restart deletes its screen and starts a fresh flow', async () => {
    const { svc, tap } = confirmService();

    const rec = await tap('draft:restart');

    expect(rec.deleted).toBe(true);
    expect(svc.cancelActiveDraft).toHaveBeenCalledTimes(1);
    expect(svc.startProductCreation).toHaveBeenCalledTimes(1);
  });

  it('draft:restart still refuses to cancel a draft with images in flight', async () => {
    const { svc, tap, replies } = confirmService();
    svc.drafts.findImagesInFlight = jest
      .fn()
      .mockResolvedValue({ id: 'img_1' });

    await tap('draft:restart');

    // The in-flight guard is untouched by the cleanup: no draft is discarded.
    expect(svc.cancelActiveDraft).not.toHaveBeenCalled();
    expect(svc.startProductCreation).not.toHaveBeenCalled();
    expect(replies.length).toBe(1);
  });
});
