// Regression: the chat must hold only the LIVE wizard screen — including the
// steps answered by TYPING, not tapping.
//
// `callback-message-cleanup.spec.ts` covers the button steps, where the message
// to retire arrives on the answering update's own ctx. A text step has no such
// handle: the update that answers "Введите цену" is the SELLER's message, so
// the question can only be reached through the id recorded when it was sent.
// That recording — and the pairing of question and answer as ONE spent
// exchange — is what these tests pin.
//
// Four properties are load-bearing and each is asserted separately:
//   1. an ACCEPTED answer retires the PROMPT — and only the prompt;
//   2. the seller's own messages are NEVER deleted, at any step, accepted or
//      not: they are the record of what the seller told the bot, and a chat
//      that eats them leaves the seller unable to see what they have said;
//   3. a REJECTED answer additionally keeps the QUESTION, so the seller can
//      still read what was being asked;
//   4. every delete is cosmetic — a refusal from Telegram never costs the
//      seller their listing.

import { TelegramService } from './telegram.service';
import {
  WizardSessionStore,
  WizardSession,
  WizardStep,
  beginQuestionnaire,
} from './product-wizard';

type AnyService = Record<string, any>;

/** Everything one dispatched update did to the chat. */
type ChatRecord = {
  /** Texts the bot sent, in order. */
  sent: string[];
  /** `${chatId}:${messageId}` of every message the bot deleted, in order. */
  deleted: string[];
  /** Call order, so "deleted before the next question went out" can be caught. */
  order: string[];
  /** Message ids the SELLER's own messages used — none may ever be deleted. */
  userMessageIds: number[];
};

const CHAT_ID = 500;
const USER_ID = 1;

/**
 * A TelegramService with the REAL cleanup helpers and the REAL registered
 * handlers, wired to an in-memory Telegram that hands out message ids.
 *
 * `deleteBehaviour: 'throws'` makes every delete fail the way Telegram does
 * when a message is too old or already gone.
 */
function makeBotService(deleteBehaviour: 'ok' | 'throws' = 'ok'): {
  svc: AnyService;
  rec: ChatRecord;
  /** Deliver a text message from the seller. */
  sendText: (text: string) => Promise<void>;
  /** Deliver a photo from the seller; returns its message id. */
  sendPhoto: (fileId: string, mediaGroupId?: string) => Promise<number>;
  /** The bot message currently tracked as the seller's live screen. */
  livePromptId: () => number | undefined;
  /** The validation complaint currently on screen, if any. */
  liveNoticeId: () => number | undefined;
  /** Id of the most recent message the SELLER sent. */
  lastUserMessageId: () => number;
} {
  const svc = Object.create(TelegramService.prototype) as AnyService;
  const rec: ChatRecord = {
    sent: [],
    deleted: [],
    order: [],
    userMessageIds: [],
  };

  // Handlers registered by registerHandlers, keyed by the filter they took.
  const textHandlers: ((ctx: any) => Promise<void>)[] = [];
  const photoHandlers: ((ctx: any) => Promise<void>)[] = [];

  let nextMessageId = 1000;

  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    wizard: new WizardSessionStore(),
    langCache: new Map<number, 'ru' | 'uz' | 'en'>([[USER_ID, 'ru']]),
    staleNoticeSentAt: new Map<number, number>(),
    // The two registries under test. Constructed here because this service is
    // stood up via Object.create, which runs no field initializers.
    livePrompt: new Map<number, { chatId: number; messageId: number }>(),
    liveNotice: new Map<number, { chatId: number; messageId: number }>(),
    pendingPhotoMessages: new Map<
      number,
      { chatId: number; messageId: number }[]
    >(),
    // Album buffering: the real buffer would flush on a debounce timer, which
    // these tests do not exercise — they assert what the ARRIVING updates
    // recorded, which is what a later flush would go on to delete.
    groupCtx: new Map<string, unknown>(),
    mediaBuffer: { add: jest.fn(), clear: jest.fn() },
    offerFlow: {
      registerActions: jest.fn(),
      clear: jest.fn(),
      // No offer session is active, so the wizard claims every update.
      handleText: jest.fn().mockResolvedValue(false),
      handlePhoto: jest.fn().mockResolvedValue(false),
    },
    categories: {
      findById: jest.fn().mockResolvedValue(null),
      findChildren: jest.fn().mockResolvedValue([]),
      findRootCategories: jest.fn().mockResolvedValue([]),
      validateCategorySelection: jest.fn().mockResolvedValue(undefined),
    },
    bot: {
      action: () => {},
      start: () => {},
      command: () => {},
      on: (filter: unknown, fn: (ctx: any) => Promise<void>) => {
        // Telegraf's message('text') / message('photo') filters are opaque
        // objects; the registration ORDER is what distinguishes them here (text
        // is registered first — see registerHandlers).
        if (textHandlers.length === 0) textHandlers.push(fn);
        else photoHandlers.push(fn);
      },
      telegram: {
        deleteMessage: jest.fn(async (chatId: number, messageId: number) => {
          rec.order.push(`delete:${messageId}`);
          if (deleteBehaviour === 'throws') {
            throw new Error(
              "400: Bad Request: message can't be deleted for everyone",
            );
          }
          rec.deleted.push(`${chatId}:${messageId}`);
          return true;
        }),
        sendMessage: jest.fn(),
      },
    },
    // Persistence is out of scope: these assertions are about which messages
    // survive, and the step the session lands on.
    handleFormAdvance: jest.fn(async (ctx: any, tgUserId: number, s: any) => {
      // Stand in for the real one's only visible effect: ask the next question.
      await svc.sendStepPrompt(ctx, s);
    }),
    ensureCategoryOptions: jest.fn(),
    drafts: {},
    langOf: jest.fn().mockResolvedValue('ru'),
    resolveLang: jest.fn().mockResolvedValue('ru'),
  });

  svc.registerHandlers();

  /** A ctx carrying one incoming message from the seller. */
  function makeCtx(message: Record<string, unknown>) {
    return {
      from: { id: USER_ID },
      message,
      chat: { id: CHAT_ID },
      reply: jest.fn(async (text: string) => {
        const messageId = ++nextMessageId;
        rec.order.push(`reply:${messageId}`);
        rec.sent.push(text);
        return { message_id: messageId, chat: { id: CHAT_ID } };
      }),
      deleteMessage: jest.fn(),
      answerCbQuery: jest.fn(),
      editMessageReplyMarkup: jest.fn(),
    };
  }

  async function sendText(text: string): Promise<void> {
    const messageId = ++nextMessageId;
    rec.userMessageIds.push(messageId);
    await textHandlers[0](
      makeCtx({
        message_id: messageId,
        text,
        chat: { id: CHAT_ID },
        from: { id: USER_ID },
      }),
    );
  }

  async function sendPhoto(
    fileId: string,
    mediaGroupId?: string,
  ): Promise<number> {
    const messageId = ++nextMessageId;
    rec.userMessageIds.push(messageId);
    const msg: Record<string, unknown> = {
      message_id: messageId,
      photo: [{ file_id: fileId }],
      chat: { id: CHAT_ID },
      from: { id: USER_ID },
    };
    if (mediaGroupId) msg.media_group_id = mediaGroupId;
    await photoHandlers[0](makeCtx(msg));
    return messageId;
  }

  return {
    svc,
    rec,
    sendText,
    sendPhoto,
    livePromptId: () => svc.livePrompt.get(USER_ID)?.messageId,
    liveNoticeId: () => svc.liveNotice.get(USER_ID)?.messageId,
    lastUserMessageId: () => rec.userMessageIds[rec.userMessageIds.length - 1],
  };
}

/** Seat a session on a text step, with a prompt already on screen. */
async function seatOnStep(
  svc: AnyService,
  step: WizardStep,
): Promise<WizardSession> {
  const session = svc.wizard.start(USER_ID);
  beginQuestionnaire(session);
  session.draftId = 'draft_1';
  session.step = step;
  // Pretend the question for this step was just sent, so there is a live prompt
  // to retire — the state every text handler actually runs in.
  svc.livePrompt.set(USER_ID, { chatId: CHAT_ID, messageId: 900 });
  return session;
}

// The text steps a seller answers by typing, with a VALID and an INVALID answer
// for each. Table-driven so a step added to the wizard later is one row here,
// not a new copy of the same four assertions.
const TEXT_STEPS: {
  name: string;
  step: WizardStep;
  valid: string;
  invalid: string;
  /** What the accepted answer should land on the session. */
  read: (s: WizardSession) => unknown;
}[] = [
  {
    name: 'title',
    step: WizardStep.TITLE,
    valid: 'Mobil 1 ESP 5W-30',
    invalid: 'x', // too short
    read: (s) => s.title,
  },
  {
    name: 'description',
    step: WizardStep.DESCRIPTION,
    valid: 'Полностью синтетическое масло',
    // A description that is really a command — the wizard rejects it rather
    // than filing "/start" as the product's description.
    invalid: '/start',
    read: (s) => s.description,
  },
  {
    name: 'price',
    step: WizardStep.PRICE,
    valid: '85000',
    invalid: 'abc',
    read: (s) => s.price,
  },
  {
    name: 'viscosity',
    step: WizardStep.OIL_VISCOSITY_CUSTOM,
    valid: '5W-30',
    invalid: 'не вязкость',
    read: (s) => s.oilViscosity,
  },
  {
    name: 'volume',
    step: WizardStep.OIL_VOLUME_CUSTOM,
    valid: '4',
    invalid: 'много',
    read: (s) => s.oilVolumeMl,
  },
  {
    name: 'part number',
    step: WizardStep.PART_NUMBER,
    valid: '96 953 062',
    invalid: '!', // fails the part-number shape
    read: (s) => s.partNumber,
  },
];

describe('an accepted text answer retires the question, and only the question', () => {
  it.each(TEXT_STEPS)(
    '$name: the prompt goes, the seller’s reply stays',
    async ({ step, valid, read }) => {
      const { svc, rec, sendText, lastUserMessageId } = makeBotService();
      const session = await seatOnStep(svc, step);

      await sendText(valid);

      // The answer stuck…
      expect(read(session)).toBeTruthy();
      // …the question it answered is gone…
      expect(rec.deleted).toContain(`${CHAT_ID}:900`);
      // …and the seller's own message is still there. This is the whole point:
      // exactly ONE delete went out, and it was the bot's own message.
      expect(rec.deleted).not.toContain(`${CHAT_ID}:${lastUserMessageId()}`);
      expect(rec.deleted).toEqual([`${CHAT_ID}:900`]);
    },
  );

  it.each(TEXT_STEPS)(
    '$name: the seller’s message survives even when several are sent',
    async ({ step, valid }) => {
      // Walking a step twice must not retroactively eat the first answer.
      const { svc, rec, sendText } = makeBotService();
      await seatOnStep(svc, step);
      await sendText(valid);
      const firstAnswer = rec.userMessageIds[0];

      await seatOnStep(svc, step);
      await sendText(valid);

      expect(rec.deleted).not.toContain(`${CHAT_ID}:${firstAnswer}`);
      for (const id of rec.userMessageIds) {
        expect(rec.deleted).not.toContain(`${CHAT_ID}:${id}`);
      }
    },
  );

  it('retires the old question BEFORE sending the next one', async () => {
    // The invariant the whole feature rests on: never two live screens at once.
    const { svc, rec, sendText } = makeBotService();
    await seatOnStep(svc, WizardStep.TITLE);

    await sendText('Mobil 1 ESP 5W-30');

    const lastDelete = rec.order.map((o) => o.startsWith('delete:')).lastIndexOf(true);
    const nextReply = rec.order.findIndex((o) => o.startsWith('reply:'));
    expect(nextReply).toBeGreaterThan(lastDelete);
  });

  it('tracks the NEW question, so the next answer retires the right message', async () => {
    const { svc, sendText, livePromptId } = makeBotService();
    await seatOnStep(svc, WizardStep.TITLE);

    await sendText('Mobil 1 ESP 5W-30');

    // No longer the seeded 900 — the prompt that just went out.
    expect(livePromptId()).toBeDefined();
    expect(livePromptId()).not.toBe(900);
  });
});

describe('a rejected text answer keeps the seller’s context', () => {
  it.each(TEXT_STEPS)(
    '$name: neither the question nor the bad input is deleted',
    async ({ step, invalid, read }) => {
      const { svc, rec, sendText } = makeBotService();
      const session = await seatOnStep(svc, step);
      const stepBefore = session.step;

      await sendText(invalid);

      // Nothing was applied…
      expect(read(session)).toBeFalsy();
      expect(session.step).toBe(stepBefore);
      // …so nothing is spent: the seller still sees what they typed and the
      // question they typed it at.
      expect(rec.deleted).toHaveLength(0);
    },
  );

  it('replaces the previous complaint instead of stacking them', async () => {
    // A seller who mistypes a price three times should see ONE complaint, not
    // three — the error is a transient screen like any other.
    const { svc, rec, sendText, liveNoticeId } = makeBotService();
    await seatOnStep(svc, WizardStep.PRICE);

    await sendText('abc');
    const firstComplaint = liveNoticeId();
    await sendText('still not a price');
    const secondComplaint = liveNoticeId();

    expect(secondComplaint).not.toBe(firstComplaint);
    expect(rec.sent).toHaveLength(2);
    // The QUESTION survived both retries — without it the second complaint
    // would be the only thing on screen, with nothing saying what was asked.
    expect(rec.deleted).not.toContain(`${CHAT_ID}:900`);
    // Exactly one delete: the first complaint, replaced by the second.
    expect(rec.deleted).toHaveLength(1);
  });
});

describe('text sent at a step that does not take text', () => {
  it('keeps the stray message and re-shows the real question', async () => {
    const { svc, rec, sendText, lastUserMessageId } = makeBotService();
    // BRAND is answered with a button, never by typing.
    await seatOnStep(svc, WizardStep.BRAND);

    await sendText('Chevrolet');

    // A question is back on screen…
    expect(rec.sent).toHaveLength(1);
    // …and the seller's stray message stays. Even text the wizard could do
    // nothing with is the seller's to keep.
    expect(rec.deleted).not.toContain(`${CHAT_ID}:${lastUserMessageId()}`);
  });
});

describe('the seller’s photos are never deleted', () => {
  it('keeps the photo but still retires the "send me photos" prompt', async () => {
    const { svc, rec, sendPhoto } = makeBotService();
    const session = await seatOnStep(svc, WizardStep.PHOTOS_FIRST);
    // Stand in for the accepted upload: the real handlePhotos creates the draft
    // and then retires the question it answered — and nothing else.
    svc.handlePhotos = jest.fn(async (_ctx: any, tgUserId: number) => {
      await svc.consumePromptMessage(tgUserId);
    });

    const photoId = await sendPhoto('file_1');

    // The bot's question is gone…
    expect(rec.deleted).toContain(`${CHAT_ID}:900`);
    // …and the seller's photo is still in the chat.
    expect(rec.deleted).not.toContain(`${CHAT_ID}:${photoId}`);
    expect(session.step).toBe(WizardStep.PHOTOS_FIRST);
  });

  it('keeps EVERY photo of an album', async () => {
    const { svc, rec, sendPhoto } = makeBotService();
    await seatOnStep(svc, WizardStep.PHOTOS_FIRST);
    svc.handlePhotos = jest.fn(async (_ctx: any, tgUserId: number) => {
      await svc.consumePromptMessage(tgUserId);
    });

    const ids = [
      await sendPhoto('file_1', 'album_1'),
      await sendPhoto('file_2', 'album_1'),
      await sendPhoto('file_3', 'album_1'),
    ];

    for (const id of ids) expect(rec.deleted).not.toContain(`${CHAT_ID}:${id}`);
  });

  it('keeps photos the wizard refused', async () => {
    // Photos sent at a question step answered nothing — and are still the
    // seller's record of what they sent.
    const { svc, rec, sendPhoto } = makeBotService();
    await seatOnStep(svc, WizardStep.TITLE);

    const photoId = await sendPhoto('file_1');

    expect(rec.deleted).not.toContain(`${CHAT_ID}:${photoId}`);
  });

  it('never deletes a photo across a whole upload sequence', async () => {
    // The regression guard: refused photos, then accepted ones, and not one of
    // the seller's messages goes.
    const { svc, rec, sendPhoto } = makeBotService();
    await seatOnStep(svc, WizardStep.TITLE);
    await sendPhoto('file_old'); // refused: wrong step

    await seatOnStep(svc, WizardStep.PHOTOS_FIRST);
    svc.handlePhotos = jest.fn(async (_ctx: any, tgUserId: number) => {
      await svc.consumePromptMessage(tgUserId);
    });
    await sendPhoto('file_new');

    for (const id of rec.userMessageIds) {
      expect(rec.deleted).not.toContain(`${CHAT_ID}:${id}`);
    }
  });
});

describe('every delete is cosmetic', () => {
  it('applies the answer and asks the next question when Telegram refuses', async () => {
    const { svc, rec, sendText } = makeBotService('throws');
    const session = await seatOnStep(svc, WizardStep.TITLE);

    await sendText('Mobil 1 ESP 5W-30');

    // The refusal was swallowed…
    expect(rec.deleted).toHaveLength(0);
    // …neither the state transition nor the next question was lost…
    expect(session.title).toBe('Mobil 1 ESP 5W-30');
    expect(svc.handleFormAdvance).toHaveBeenCalledTimes(1);
    // …and a failing bot-message delete never reaches for the seller's message
    // as a fallback.
    expect(rec.order.filter((o) => o.startsWith('delete:'))).toEqual([
      'delete:900',
    ]);
  });

  it('survives a step with nothing tracked to delete', async () => {
    // No prompt was ever recorded (a restart, an expired session) — the answer
    // must still be taken.
    const { svc, sendText } = makeBotService();
    const session = await seatOnStep(svc, WizardStep.TITLE);
    svc.livePrompt.delete(USER_ID);

    await expect(sendText('Mobil 1 ESP 5W-30')).resolves.toBeUndefined();
    expect(session.title).toBe('Mobil 1 ESP 5W-30');
  });

  it('survives registries that were never initialized', async () => {
    // This service is routinely stood up without its field initializers (the
    // bot specs use Object.create). Cleanup must degrade to a no-op rather than
    // throw inside a listing step.
    const { svc, sendText } = makeBotService();
    const session = await seatOnStep(svc, WizardStep.TITLE);
    svc.livePrompt = undefined;
    svc.liveNotice = undefined;
    svc.pendingPhotoMessages = undefined;

    await expect(sendText('Mobil 1 ESP 5W-30')).resolves.toBeUndefined();
    expect(session.title).toBe('Mobil 1 ESP 5W-30');
  });
});

describe('button screens outside the questionnaire are transient too', () => {
  /** A service with only what these two ctx-free/keyboard paths touch. */
  function makeScreenService() {
    const deleted: number[] = [];
    let nextId = 800;
    const svc = Object.create(TelegramService.prototype) as AnyService;
    Object.assign(svc, {
      logger: { log() {}, warn() {}, error() {}, debug() {} },
      livePrompt: new Map<number, { chatId: number; messageId: number }>(),
      liveNotice: new Map<number, { chatId: number; messageId: number }>(),
      pendingPhotoMessages: new Map(),
      resolveLang: jest.fn().mockResolvedValue('ru'),
      bot: {
        telegram: {
          deleteMessage: jest.fn(async (_c: number, id: number) => {
            deleted.push(id);
            return true;
          }),
          sendMessage: jest.fn(async () => ({
            message_id: ++nextId,
            chat: { id: USER_ID },
          })),
        },
      },
    });
    return { svc, deleted };
  }

  it('the images-failed screen retires the holding line it answers', async () => {
    // The seller is looking at "завершаем обработку фото"; the failure notice
    // must replace it, not sit under it contradicting it.
    const { svc, deleted } = makeScreenService();
    svc.livePrompt.set(USER_ID, { chatId: USER_ID, messageId: 900 });

    await svc.onDraftImagesFailed({
      draftId: 'draft_1',
      tgId: BigInt(USER_ID),
      failedCount: 1,
    });

    expect(deleted).toEqual([900]);
    // …and the failure screen is itself tracked, so its buttons can retire it.
    expect(svc.livePrompt.get(USER_ID)).toBeDefined();
  });

  it('a second failure notice replaces the first', async () => {
    const { svc, deleted } = makeScreenService();

    await svc.onDraftImagesFailed({
      draftId: 'draft_1',
      tgId: BigInt(USER_ID),
      failedCount: 1,
    });
    const first = svc.livePrompt.get(USER_ID).messageId;
    await svc.onDraftImagesFailed({
      draftId: 'draft_1',
      tgId: BigInt(USER_ID),
      failedCount: 2,
    });

    expect(deleted).toEqual([first]);
  });

  it('a failed send never propagates out of the event listener', async () => {
    const { svc } = makeScreenService();
    svc.bot.telegram.sendMessage = jest.fn(async () => {
      throw new Error('403: bot was blocked by the user');
    });

    await expect(
      svc.onDraftImagesFailed({
        draftId: 'draft_1',
        tgId: BigInt(USER_ID),
        failedCount: 1,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the boundary itself: no seller message is ever deleted', () => {
  // A single sweep over the whole questionnaire — valid answers, invalid ones,
  // stray text, photos — asserting the one rule that must hold everywhere. If a
  // future change reintroduces a delete of the seller's own message anywhere on
  // these paths, this fails even if every step-specific test still passes.
  it('survives a full mixed run with every seller message intact', async () => {
    const { svc, rec, sendText, sendPhoto } = makeBotService();

    await seatOnStep(svc, WizardStep.PHOTOS_FIRST);
    svc.handlePhotos = jest.fn(async (_ctx: any, tgUserId: number) => {
      await svc.consumePromptMessage(tgUserId);
    });
    await sendPhoto('file_1', 'album_1');
    await sendPhoto('file_2', 'album_1');

    await seatOnStep(svc, WizardStep.TITLE);
    await sendText('x'); // rejected — too short
    await sendText('Mobil 1 ESP 5W-30'); // accepted

    await seatOnStep(svc, WizardStep.PRICE);
    await sendText('abc'); // rejected
    await sendText('85000'); // accepted

    await seatOnStep(svc, WizardStep.BRAND);
    await sendText('Chevrolet'); // stray: a button step

    // Something WAS cleaned up — this is not passing because nothing happened.
    expect(rec.deleted.length).toBeGreaterThan(0);
    // And not one of the deletes was a seller message.
    expect(rec.userMessageIds.length).toBe(7);
    for (const id of rec.userMessageIds) {
      expect(rec.deleted).not.toContain(`${CHAT_ID}:${id}`);
    }
  });
});
