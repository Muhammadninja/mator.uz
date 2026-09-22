/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the handler harness is untyped by design, like the other TelegramService specs; the Telegram/queue fakes mirror async APIs */
// End-to-end specs for Driver's Village photo updates over Telegram:
//   photos + caption = code_1c → same draft/worker/coordinator pipeline →
//   same preview media → Confirm (gallery replaced) / Cancel (nothing changed).
//
// The REAL registered handlers, TelegramService methods, DraftCoordinator and
// DriversVillagePhotoService run; only the edges are faked: the database
// (test/utils/dv-photo-world.ts), BullMQ (a recording enqueue + `settle`, which
// stands in for the image worker), Cloudinary and the Telegram API.

import {
  DV_CODE,
  FakeDrafts,
  FakePrisma,
} from '../../test/utils/dv-photo-world';
import { DraftCoordinator } from './draft-coordinator';
import { DraftEvent } from './draft-events';
import { DriversVillagePhotoService } from './drivers-village-photo.service';
import { makeFakeLock } from './draft-lock.test-util';
import type { ProductDraftService } from './product-draft.service';
import { WizardSessionStore, WizardStep } from './product-wizard';
import { TelegramService } from './telegram.service';

const USER = 42;

function setup() {
  const world = new FakePrisma();
  const drafts = new FakeDrafts(world);
  const pendingEvents: Promise<void>[] = [];
  const svc: any = Object.create(TelegramService.prototype);
  const events = {
    emit: (name: string, payload: any) => {
      if (name === DraftEvent.READY_FOR_PREVIEW)
        pendingEvents.push(svc.onDraftReadyForPreview(payload));
      if (name === DraftEvent.IMAGES_FAILED)
        pendingEvents.push(svc.onDraftImagesFailed(payload));
      return true;
    },
  };
  const telemetry = { event: jest.fn(), metric: jest.fn() };
  const coordinator = new DraftCoordinator(
    drafts as unknown as ProductDraftService,
    events as never,
    telemetry as never,
  );
  const actions: { trigger: unknown; fn: (ctx: any) => Promise<void> }[] = [];
  const photoHandlers: ((ctx: any) => Promise<void>)[] = [];
  const textHandlers: ((ctx: any) => Promise<void>)[] = [];
  const mediaAdds: unknown[][] = [];
  let nextId = 5000;
  const telegram = {
    sendPhoto: jest.fn(async () => ({ message_id: ++nextId })),
    sendMediaGroup: jest.fn(async () => [{ message_id: ++nextId }]),
    sendMessage: jest.fn(async () => ({ message_id: ++nextId })),
    deleteMessage: jest.fn(async () => true),
  };

  Object.assign(svc, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    wizard: new WizardSessionStore(),
    pending: new Map(),
    langCache: new Map([[USER, 'ru']]),
    livePrompt: new Map(),
    liveNotice: new Map(),
    staleNoticeSentAt: new Map(),
    groupCtx: new Map(),
    mediaBuffer: {
      add: (...args: unknown[]) => mediaAdds.push(args),
      clear: jest.fn(),
    },
    draftTtlMs: 24 * 3600 * 1000,
    offerFlow: {
      registerActions: jest.fn(),
      clear: jest.fn(),
      handleText: jest.fn().mockResolvedValue(false),
      handlePhoto: jest.fn().mockResolvedValue(false),
    },
    categories: { findById: jest.fn().mockResolvedValue(null) },
    sellers: {
      findByTgId: jest
        .fn()
        .mockResolvedValue({ id: 1, status: 'ACTIVE', lang: 'RU' }),
    },
    drafts,
    draftCoordinator: coordinator,
    queue: {
      enqueueImage: jest.fn(async ({ imageId }: { imageId: string }) => ({
        id: `job:${imageId}`,
      })),
      reenqueueImage: jest.fn(),
      removeImageJob: jest.fn().mockResolvedValue(undefined),
    },
    locks: makeFakeLock(),
    telemetry,
    cloudinary: { deleteAssets: jest.fn().mockResolvedValue(undefined) },
    catalogProjection: {
      projectStock: jest.fn().mockResolvedValue('part_stock_500'),
    },
    dvPhotos: new DriversVillagePhotoService(
      world.prisma,
      drafts as unknown as ProductDraftService,
    ),
    bot: {
      action: (trigger: unknown, fn: (ctx: any) => Promise<void>) =>
        actions.push({ trigger, fn }),
      start: () => {},
      command: () => {},
      on: (_filter: unknown, fn: (ctx: any) => Promise<void>) =>
        (textHandlers.length === 0 ? textHandlers : photoHandlers).push(fn),
      telegram,
    },
  });
  svc.registerHandlers();

  const replies: string[] = [];
  const ctxFor = (extra: Record<string, unknown> = {}) => ({
    from: { id: USER },
    chat: { id: USER },
    reply: jest.fn(async (text: string) => {
      replies.push(text);
      return { message_id: ++nextId, chat: { id: USER } };
    }),
    answerCbQuery: jest.fn(),
    deleteMessage: jest.fn(),
    editMessageReplyMarkup: jest.fn(),
    ...extra,
  });

  /** A single photo (optionally captioned), through the real photo handler. */
  async function sendPhoto(fileId: string, caption?: string, from = USER) {
    const msg: Record<string, unknown> = {
      message_id: ++nextId,
      photo: [{ file_id: fileId }],
      from: { id: from },
      chat: { id: from },
    };
    if (caption !== undefined) msg.caption = caption;
    await photoHandlers[0]({ ...ctxFor({ from: { id: from } }), message: msg });
  }

  /** An album: every photo through the handler, then the buffer's flush. */
  async function sendAlbum(fileIds: string[], caption: string) {
    mediaAdds.length = 0;
    for (const [i, fileId] of fileIds.entries()) {
      const msg: Record<string, unknown> = {
        message_id: ++nextId,
        media_group_id: 'g1',
        photo: [{ file_id: fileId }],
        from: { id: USER },
        chat: { id: USER },
      };
      if (i === 1) msg.caption = caption; // the caption rides on ONE album photo
      await photoHandlers[0]({ ...ctxFor(), message: msg });
    }
    // Exactly what MediaGroupBuffer's flush hands over (first non-empty caption).
    const flushedCaption = (mediaAdds.find((a) => a[2]) ?? [])[2] ?? null;
    await svc.routePhotos(
      ctxFor(),
      USER,
      mediaAdds.map((a) => a[1]),
      flushedCaption,
    );
  }

  /** The image worker finished every photo of the latest draft. */
  async function finishImages(outcome: 'READY' | 'FAILED' = 'READY') {
    const draftId = [...drafts.drafts.keys()].at(-1)!;
    drafts.settle(draftId, outcome);
    await coordinator.onImageSettled(draftId);
    await Promise.all(pendingEvents.splice(0));
    return draftId;
  }

  /** Tap an inline button by its callback data. */
  async function tap(data: string, from = USER) {
    for (const a of actions) {
      const m =
        a.trigger instanceof RegExp
          ? a.trigger.exec(data)
          : a.trigger === data
            ? [data]
            : null;
      if (m) return a.fn(ctxFor({ from: { id: from }, match: m }));
    }
    throw new Error(`no action for ${data}`);
  }

  /** Callback data of the preview's buttons (last reply markup sent). */
  function previewButtons(): string[] {
    const calls = [
      ...telegram.sendPhoto.mock.calls,
      ...telegram.sendMessage.mock.calls,
    ] as any[];
    const withKb = calls.filter((c) => c[2]?.reply_markup).at(-1);
    return withKb[2].reply_markup.inline_keyboard
      .flat()
      .map((b: { callback_data: string }) => b.callback_data);
  }

  return {
    world,
    drafts,
    svc,
    telegram,
    replies,
    sendPhoto,
    sendAlbum,
    finishImages,
    tap,
    previewButtons,
    mediaAdds,
  };
}

const dvGallery = (w: FakePrisma) =>
  w.state.productImages.filter((i) => i.productId === 100);
/** Everything on the DV product and stock EXCEPT its photos. */
const dvNonPhotoState = (w: FakePrisma) => {
  const { imageUrl: _ignored, ...product } = w.state.products.find(
    (p) => p.id === 100,
  )!;
  void _ignored;
  return { product, stock: w.state.stocks.find((s) => s.id === 500) };
};

describe("Driver's Village photo update over Telegram", () => {
  it('1. existing code_1c + one photo → the same preview: processed photo, caption, Confirm/Cancel', async () => {
    const t = setup();
    await t.sendPhoto('f1', DV_CODE);
    const draftId = await t.finishImages();

    expect(t.svc.queue.enqueueImage).toHaveBeenCalledTimes(1);
    expect(t.telegram.sendPhoto).toHaveBeenCalledTimes(1);
    const [chat, url, opts] = t.telegram.sendPhoto.mock.calls[0] as any[];
    expect([chat, url]).toEqual([USER, 'https://cdn/proc/f1.jpg']);
    expect(opts.caption).toContain(DV_CODE);
    expect(opts.caption).toContain('Амортизатор передний RH');
    expect(t.previewButtons()).toEqual([
      `dvph:ok:${draftId}`,
      `dvph:no:${draftId}`,
    ]);
    // Nothing is written to the product before Confirm.
    expect(t.world.writes).toEqual([]);
  });

  it('2. album of 3 → preview shows all 3 processed photos in album order', async () => {
    const t = setup();
    await t.sendAlbum(['a1', 'a2', 'a3'], DV_CODE);
    expect(t.mediaAdds.map((a) => a[2])).toEqual([null, DV_CODE, null]);
    await t.finishImages();

    const [, media] = t.telegram.sendMediaGroup.mock.calls[0] as any[];
    expect(media.map((m: { media: string }) => m.media)).toEqual([
      'https://cdn/proc/a1.jpg',
      'https://cdn/proc/a2.jpg',
      'https://cdn/proc/a3.jpg',
    ]);
    expect(t.previewButtons()[0]).toMatch(/^dvph:ok:/);
  });

  it('3. Cancel → product photos, product and stock unchanged; only the temporary uploads go', async () => {
    const t = setup();
    const before = structuredClone(t.world.state);
    await t.sendAlbum(['a1', 'a2'], DV_CODE);
    const draftId = await t.finishImages();

    await t.tap(`dvph:no:${draftId}`);

    expect(t.world.state).toEqual(before);
    expect(t.world.writes).toEqual([]);
    expect(t.drafts.drafts.get(draftId)!.status).toBe('CANCELLED');
    expect(t.svc.cloudinary.deleteAssets).toHaveBeenCalledWith([
      'orig_a1',
      'proc_a1',
      'orig_a2',
      'proc_a2',
    ]);
    expect(t.replies.at(-1)).toContain('Обновление фото отменено');
  });

  it('4–6. Confirm → gallery replaced in order, first primary, imageUrl = first; nothing else changes', async () => {
    const t = setup();
    const before = dvNonPhotoState(t.world);
    await t.sendAlbum(['a1', 'a2', 'a3'], DV_CODE);
    const draftId = await t.finishImages();

    await t.tap(`dvph:ok:${draftId}`);

    expect(dvGallery(t.world)).toEqual([
      {
        productId: 100,
        url: 'https://cdn/proc/a1.jpg',
        sortOrder: 0,
        isPrimary: true,
      },
      {
        productId: 100,
        url: 'https://cdn/proc/a2.jpg',
        sortOrder: 1,
        isPrimary: false,
      },
      {
        productId: 100,
        url: 'https://cdn/proc/a3.jpg',
        sortOrder: 2,
        isPrimary: false,
      },
    ]);
    expect(t.world.state.products.find((p) => p.id === 100)!.imageUrl).toBe(
      'https://cdn/proc/a1.jpg',
    );
    // Title, numbers, category, fitment flag, price, quantity, unit, source fields.
    expect(dvNonPhotoState(t.world)).toEqual(before);
    expect(t.world.state.products).toHaveLength(2);
    expect(t.world.state.stocks).toHaveLength(2);
    expect(t.drafts.drafts.get(draftId)!.status).toBe('PUBLISHED');
    expect(t.svc.catalogProjection.projectStock).toHaveBeenCalledWith(500);
    // Only the draft's intermediate ORIGINALS are deleted on publish.
    expect(t.svc.cloudinary.deleteAssets).toHaveBeenCalledWith([
      'orig_a1',
      'orig_a2',
      'orig_a3',
    ]);
    expect(t.replies.at(-1)).toContain(`Фото позиции ${DV_CODE} обновлены (3)`);
  });

  it('7. unknown code_1c → clear rejection and zero writes (no draft, no job, no upload)', async () => {
    const t = setup();
    await t.sendPhoto('f1', '00-99999999');

    expect(t.replies).toEqual([
      expect.stringContaining('с кодом 00-99999999 не найдена'),
    ]);
    expect(t.drafts.createWithImages).not.toHaveBeenCalled();
    expect(t.svc.queue.enqueueImage).not.toHaveBeenCalled();
    expect(t.world.writes).toEqual([]);
  });

  it("8. a Telegram seller's listing with the same GM/OEM value is never touched", async () => {
    const t = setup();
    const tgBefore = {
      product: structuredClone(
        t.world.state.products.find((p) => p.id === 200),
      ),
      photos: structuredClone(
        t.world.state.productImages.filter((i) => i.productId === 200),
      ),
    };
    // The shared number as a caption is NOT a code_1c → the ordinary wizard.
    await t.sendPhoto('x1', '96611630');
    expect(t.drafts.createWithImages).not.toHaveBeenCalled();

    await t.sendPhoto('f1', DV_CODE);
    const draftId = await t.finishImages();
    await t.tap(`dvph:ok:${draftId}`);

    expect(t.world.state.products.find((p) => p.id === 200)).toEqual(
      tgBefore.product,
    );
    expect(
      t.world.state.productImages.filter((i) => i.productId === 200),
    ).toEqual(tgBefore.photos);
    expect(
      t.world.writes.every((w) => w.endsWith(':100') || w.includes(':100:')),
    ).toBe(true);
  });

  it('9. the same code_1c again with another photo set updates the SAME product', async () => {
    const t = setup();
    await t.sendPhoto('f1', DV_CODE);
    await t.tap(`dvph:ok:${await t.finishImages()}`);
    await t.sendAlbum(['b1', 'b2'], DV_CODE);
    await t.tap(`dvph:ok:${await t.finishImages()}`);

    expect(dvGallery(t.world).map((i) => i.url)).toEqual([
      'https://cdn/proc/b1.jpg',
      'https://cdn/proc/b2.jpg',
    ]);
    expect(t.world.state.products).toHaveLength(2);
    expect(t.world.state.stocks).toHaveLength(2);
    expect([...t.drafts.drafts.values()].map((d) => d.targetStockId)).toEqual([
      500, 500,
    ]);
  });

  it('10. photos without a code caption keep the ordinary listing flow unchanged', async () => {
    for (const caption of [undefined, 'Колодки передние, новые']) {
      const t = setup();
      t.svc.wizard.start(USER, 'ru');
      await t.sendPhoto('p1', caption);

      expect(t.drafts.createWithImages).toHaveBeenCalledTimes(1);
      const params = t.drafts.createWithImages.mock.calls[0][0];
      expect(params).toMatchObject({ sellerId: 1, formStep: WizardStep.BRAND });
      expect(params).not.toHaveProperty('targetStockId');
      expect(t.svc.wizard.get(USER).step).toBe(WizardStep.BRAND);
      expect(t.world.writes).toEqual([]);
    }
  });

  describe('guards', () => {
    it('only the user the preview was sent to can confirm it', async () => {
      const t = setup();
      await t.sendPhoto('f1', DV_CODE);
      const draftId = await t.finishImages();
      await t.tap(`dvph:ok:${draftId}`, 999);
      expect(t.world.writes).toEqual([]);
      expect(t.drafts.drafts.get(draftId)!.status).toBe('READY_FOR_PREVIEW');
    });

    it('a second Confirm tap is refused and writes nothing more', async () => {
      const t = setup();
      await t.sendPhoto('f1', DV_CODE);
      const draftId = await t.finishImages();
      await t.tap(`dvph:ok:${draftId}`);
      const writes = t.world.writes.length;
      await t.tap(`dvph:ok:${draftId}`);
      expect(t.world.writes).toHaveLength(writes);
      expect(t.replies.at(-1)).toContain('уже');
    });

    it('Cancel after Confirm leaves the new gallery in place', async () => {
      const t = setup();
      await t.sendPhoto('f1', DV_CODE);
      const draftId = await t.finishImages();
      await t.tap(`dvph:ok:${draftId}`);
      await t.tap(`dvph:no:${draftId}`);
      expect(dvGallery(t.world).map((i) => i.url)).toEqual([
        'https://cdn/proc/f1.jpg',
      ]);
    });

    it('failed image processing drops the update and asks to resend; no product write', async () => {
      const t = setup();
      await t.sendPhoto('f1', DV_CODE);
      const draftId = await t.finishImages('FAILED');
      expect(t.drafts.drafts.get(draftId)!.status).toBe('CANCELLED');
      expect(t.telegram.sendMessage).toHaveBeenLastCalledWith(
        USER,
        expect.stringContaining('Не удалось обработать фото (1)'),
      );
      expect(t.world.writes).toEqual([]);
    });

    it('never retires the listing question of a user who is mid-questionnaire', async () => {
      const t = setup();
      const session = t.svc.wizard.start(USER, 'ru');
      session.step = WizardStep.TITLE;
      t.svc.livePrompt.set(USER, { chatId: USER, messageId: 77 });
      await t.sendPhoto('f1', DV_CODE);
      await t.finishImages();
      expect(t.telegram.deleteMessage).not.toHaveBeenCalledWith(USER, 77);
      expect(t.svc.livePrompt.get(USER)).toEqual({
        chatId: USER,
        messageId: 77,
      });
    });

    it('a Confirm tap mid-questionnaire keeps the listing question tracked', async () => {
      const t = setup();
      const session = t.svc.wizard.start(USER, 'ru');
      session.step = WizardStep.TITLE;
      t.svc.livePrompt.set(USER, { chatId: USER, messageId: 77 });
      await t.sendPhoto('f1', DV_CODE);
      const draftId = await t.finishImages();
      await t.tap(`dvph:ok:${draftId}`);
      expect(dvGallery(t.world).map((i) => i.url)).toEqual([
        'https://cdn/proc/f1.jpg',
      ]);
      // The question is still the seller's live screen, so answering it later
      // retires it as usual.
      expect(t.svc.livePrompt.get(USER)).toEqual({
        chatId: USER,
        messageId: 77,
      });
    });

    it('a duplicate images-failed event notifies the user once', async () => {
      const t = setup();
      await t.sendPhoto('f1', DV_CODE);
      const draftId = await t.finishImages('FAILED');
      // Two workers settling the last images at once both see the batch done.
      await t.svc.onDraftImagesFailed({
        draftId,
        tgId: BigInt(USER),
        failedCount: 1,
        targetStockId: 500,
      });
      const notices = t.telegram.sendMessage.mock.calls.filter((c: any[]) =>
        String(c[1]).includes('Не удалось обработать фото'),
      );
      expect(notices).toHaveLength(1);
    });

    it('a failed save tells the user without exposing the database error', async () => {
      const t = setup();
      await t.sendPhoto('f1', DV_CODE);
      const draftId = await t.finishImages();
      jest
        .spyOn(t.svc.dvPhotos, 'replaceGallery')
        .mockRejectedValueOnce(
          new Error('Invalid `tx.productImage.deleteMany()` invocation'),
        );
      await t.tap(`dvph:ok:${draftId}`);
      expect(t.replies.at(-1)).toContain('Не удалось сохранить фото');
      expect(t.replies.join('\n')).not.toContain('productImage');
      expect(dvGallery(t.world).map((i) => i.url)).toEqual([
        'https://old/dv-0.jpg',
        'https://old/dv-1.jpg',
      ]);
      // Left COMMITTING for the TTL sweep, exactly like a listing commit.
      expect(t.drafts.drafts.get(draftId)!.status).toBe('COMMITTING');
    });
  });
});
