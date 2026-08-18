// The seller bot's language behaviour end to end through TelegramService's own
// internals: how a language is resolved and cached, what /start does for a
// seller who has never chosen one, what a language button does, and the fact
// that both the wizard's prompts and the CATEGORY BUTTONS come out in the
// chosen language.
//
// The private methods are reached through an index signature, exactly as the
// sibling draft-flow specs do, without widening the production API.

import { BotLanguage, SellerStatus } from '@prisma/client';
import { TelegramService } from './telegram.service';
import {
  WizardSessionStore,
  WizardStep,
  stepPrompt,
  categoryKeyboard,
} from './product-wizard';
import { t } from './i18n';
import type { AppLang } from '../common/app-lang.util';

type AnyService = Record<string, any>;

/** A seller row as `sellers.findByTgId` returns it. */
const seller = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  status: SellerStatus.ACTIVE,
  lang: BotLanguage.RU,
  ...over,
});

function makeService(over: Partial<Record<string, unknown>> = {}): AnyService {
  const svc = Object.create(TelegramService.prototype) as AnyService;
  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    wizard: new WizardSessionStore(),
    langCache: new Map<number, AppLang>(),
    staleNoticeSentAt: new Map<number, number>(),
    sellers: {
      findByTgId: jest.fn().mockResolvedValue(seller()),
      setLanguage: jest.fn().mockResolvedValue(undefined),
    },
    drafts: {
      findAwaitingPreview: jest.fn().mockResolvedValue(null),
      findImagesInFlight: jest.fn().mockResolvedValue(null),
      findResumable: jest.fn().mockResolvedValue(null),
    },
    categories: {
      findRootCategories: jest.fn().mockResolvedValue([]),
      findChildren: jest.fn().mockResolvedValue([]),
    },
    sendStepPrompt: jest.fn().mockResolvedValue(undefined),
    ...over,
  });
  return svc;
}

/** A minimal ctx that records what the bot replied. */
function makeCtx() {
  const replies: { text: string; extra?: unknown }[] = [];
  return {
    replies,
    ctx: {
      reply: jest.fn(async (text: string, extra?: unknown) => {
        replies.push({ text, extra });
      }),
    } as never,
  };
}

describe('langOf — resolving a seller’s language', () => {
  it('reads the stored language and caches it', async () => {
    const svc = makeService();
    svc.sellers.findByTgId.mockResolvedValue(seller({ lang: BotLanguage.UZ }));

    expect(await svc.langOf(42)).toBe('uz');
    expect(await svc.langOf(42)).toBe('uz');
    // Second call is served from the cache — a language changes far less often
    // than the bot answers an update.
    expect(svc.sellers.findByTgId).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache an unset language, so a later choice is picked up', async () => {
    const svc = makeService();
    svc.sellers.findByTgId.mockResolvedValue(seller({ lang: null }));

    expect(await svc.langOf(42)).toBe('ru');
    svc.sellers.findByTgId.mockResolvedValue(seller({ lang: BotLanguage.EN }));
    expect(await svc.langOf(42)).toBe('en');
  });

  it('falls back to the default when the lookup fails, never throwing', async () => {
    const svc = makeService();
    svc.sellers.findByTgId.mockRejectedValue(new Error('db down'));
    // A handler that cannot determine a language must still answer the seller.
    expect(await svc.langOf(42)).toBe('ru');
  });

  it('prefers an open dialogue’s language over a database read', async () => {
    const svc = makeService();
    svc.wizard.start(42, 'en');
    expect(await svc.resolveLang(42)).toBe('en');
    expect(svc.sellers.findByTgId).not.toHaveBeenCalled();
  });
});

describe('setLang — a choice takes effect immediately', () => {
  it('persists it, caches it, and moves the LIVE dialogue to it', async () => {
    const svc = makeService();
    const session = svc.wizard.start(42, 'ru');

    await svc.setLang(42, 'uz');

    expect(svc.sellers.setLanguage).toHaveBeenCalledWith(
      BigInt(42),
      BotLanguage.UZ,
    );
    expect(svc.langCache.get(42)).toBe('uz');
    // The seller is mid-listing: their next prompt must be in the new language,
    // and nothing they already answered is lost.
    expect(session.lang).toBe('uz');
    expect(session.step).toBe(WizardStep.PHOTOS_FIRST);
  });
});

describe('the language picker', () => {
  it('asks trilingually and offers one button per language', async () => {
    const svc = makeService();
    const { ctx, replies } = makeCtx();

    await svc.promptLanguage(ctx, 'ru');

    expect(replies[0].text).toContain('Выберите язык');
    expect(replies[0].text).toContain('Tilingizni tanlang');
    expect(replies[0].text).toContain('Choose your language');
    const rows = (
      replies[0].extra as {
        reply_markup: { inline_keyboard: { callback_data: string }[][] };
      }
    ).reply_markup.inline_keyboard;
    expect(rows.flat().map((b) => b.callback_data)).toEqual([
      'lang:ru',
      'lang:uz',
      'lang:en',
    ]);
  });
});

describe('startForSeller — the account-status replies are localized', () => {
  it.each(['ru', 'uz', 'en'] as AppLang[])(
    'tells a PENDING seller to wait in %s',
    async (lang) => {
      const svc = makeService();
      const { ctx, replies } = makeCtx();

      await svc.startForSeller(ctx, 42, 1, SellerStatus.PENDING, lang);

      expect(replies[0].text).toBe(t(lang, 'start.pending'));
    },
  );

  it.each(['ru', 'uz', 'en'] as AppLang[])(
    'tells a REJECTED seller in %s',
    async (lang) => {
      const svc = makeService();
      const { ctx, replies } = makeCtx();

      await svc.startForSeller(ctx, 42, 1, SellerStatus.REJECTED, lang);

      expect(replies[0].text).toBe(t(lang, 'start.rejected'));
    },
  );

  it('starts an ACTIVE seller’s wizard IN their language', async () => {
    const svc = makeService();
    const { ctx } = makeCtx();

    await svc.startForSeller(ctx, 42, 1, SellerStatus.ACTIVE, 'uz');

    expect(svc.wizard.get(42).lang).toBe('uz');
    expect(svc.sendStepPrompt).toHaveBeenCalled();
  });

  it('offers to resume an unfinished draft with localized buttons', async () => {
    const svc = makeService();
    svc.drafts.findResumable.mockResolvedValue({ id: 'draft_1' });
    const { ctx, replies } = makeCtx();

    await svc.startForSeller(ctx, 42, 1, SellerStatus.ACTIVE, 'en');

    expect(replies[0].text).toBe(t('en', 'draft.resumePrompt'));
    const rows = (
      replies[0].extra as {
        reply_markup: { inline_keyboard: { text: string }[][] };
      }
    ).reply_markup.inline_keyboard;
    expect(rows.flat().map((b) => b.text)).toEqual([
      t('en', 'btn.continue'),
      t('en', 'btn.startOver'),
    ]);
  });
});

describe('category buttons are rendered in the seller’s language', () => {
  const ROOTS = [
    {
      id: 'brake-system',
      name: 'Brake System',
      nameRu: 'Тормозная система',
      nameUz: 'Tormoz tizimi',
      nameEn: 'Brake System',
    },
    {
      id: 'engine-system',
      name: 'Engine',
      nameRu: 'Двигатель',
      nameUz: 'Dvigatel',
      nameEn: 'Engine',
    },
  ];

  it.each([
    ['ru', ['Тормозная система', 'Двигатель']],
    ['uz', ['Tormoz tizimi', 'Dvigatel']],
    ['en', ['Brake System', 'Engine']],
  ] as [AppLang, string[]][])(
    'labels the roots in %s',
    async (lang, expected) => {
      const svc = makeService();
      svc.categories.findRootCategories.mockResolvedValue(ROOTS);

      const options = await svc.loadCategoryOptions(null, lang);

      expect(options.map((o: { name: string }) => o.name)).toEqual(expected);
      // The stable ID is what a tap carries — localization never touches it.
      expect(options.map((o: { id: string }) => o.id)).toEqual([
        'brake-system',
        'engine-system',
      ]);
    },
  );

  it('falls back to the canonical name for an untranslated row', async () => {
    const svc = makeService();
    svc.categories.findChildren.mockResolvedValue([
      { id: 'turbochargers', name: 'Turbochargers' },
    ]);
    const [option] = await svc.loadCategoryOptions('engine-system', 'uz');
    expect(option.name).toBe('Turbochargers');
  });

  it('carries the localized labels through to the rendered keyboard', () => {
    const store = new WizardSessionStore();
    const session = store.start(42, 'uz');
    session.step = WizardStep.CATEGORY;
    session.categoryOptions = [
      { id: 'brake-system', name: 'Tormoz tizimi' },
      { id: 'engine-system', name: 'Dvigatel' },
    ];

    const rows = categoryKeyboard(session).reply_markup.inline_keyboard;
    // The category labels, plus the Back row the wizard appends — localized too.
    expect(rows.flat().map((b) => (b as { text: string }).text)).toEqual([
      'Tormoz tizimi',
      'Dvigatel',
      t('uz', 'btn.back'),
    ]);
  });
});

describe('wizard prompts follow the session language', () => {
  it.each(['ru', 'uz', 'en'] as AppLang[])(
    'asks for the brand in %s, with a Back button in the same language',
    (lang) => {
      const store = new WizardSessionStore();
      const session = store.start(42, lang);
      session.step = WizardStep.PRICE;

      const prompt = stepPrompt(session);

      expect(prompt.text).toBe(t(lang, 'step.price'));
      const rows = prompt.keyboard!.reply_markup.inline_keyboard;
      expect((rows[0][0] as { text: string }).text).toBe(t(lang, 'btn.back'));
    },
  );

  it('defaults to Russian for a session started without a language', () => {
    const store = new WizardSessionStore();
    const session = store.start(42);
    session.step = WizardStep.CATEGORY;
    expect(session.lang).toBe('ru');
    expect(stepPrompt(session).text).toBe(t('ru', 'step.category'));
  });
});
