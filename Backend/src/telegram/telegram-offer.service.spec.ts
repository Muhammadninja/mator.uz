// Unit tests for the "У меня есть" DM offer-capture flow.
//
// Contract pinned here:
//   • a valid deep-link opens a session and asks for price
//   • a non-offer /start payload is ignored (passthrough → false)
//   • text/photos are only consumed while a session is active
//   • price is required; photo is optional (price-only offer is valid)
//   • finalize records the offer with the seller's Telegram identity
//   • a malformed or truncated ticket id is answered "not found" and never queried

import { TelegramOfferService } from './telegram-offer.service';

// Ticket ids are UUIDs (a @db.Uuid column), so a fixture must be one too.
const TICKET_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OFFER_LINK = `offer_${TICKET_ID}`;

const TICKET = {
  id: TICKET_ID,
  status: 'PENDING',
  extractedData: { part_name: 'Тормозные колодки' },
};

function build() {
  const prisma = {
    sourcingTicket: { findUnique: jest.fn(async () => TICKET) },
  };
  const offers = { createOffer: jest.fn(async () => ({ id: 'soff_1' })) };
  const cloudinary = {
    uploadBuffer: jest.fn(async () => ({ url: 'https://cdn/x.png', publicId: 'p' })),
  };
  const telegramFile = { getFileUrl: jest.fn(async () => 'https://tg/file') };
  const service = new TelegramOfferService(
    prisma as never,
    offers as never,
    cloudinary as never,
    telegramFile as never,
  );
  return { service, prisma, offers, cloudinary, telegramFile };
}

/** A fake Telegraf context for Telegram user 42, with a text message. */
function ctx(text = '') {
  return {
    from: { id: 42, first_name: 'Ali', username: 'ali_dealer' },
    message: { text },
    reply: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('TelegramOfferService', () => {
  it('ignores a non-offer /start payload (passthrough)', async () => {
    const { service } = build();
    const c = ctx();
    expect(await service.startFromDeepLink(c, 'somethingelse')).toBe(false);
    expect(c.reply).not.toHaveBeenCalled();
  });

  it('opens a session and asks for price on a valid deep-link', async () => {
    const { service, prisma } = build();
    const c = ctx();
    const consumed = await service.startFromDeepLink(c, OFFER_LINK);
    expect(consumed).toBe(true);
    expect(prisma.sourcingTicket.findUnique).toHaveBeenCalledWith({
      where: { id: TICKET_ID },
    });
    expect(c.reply.mock.calls[0][0]).toContain('цену');
  });

  // A non-UUID reaching the @db.Uuid lookup makes the query FAIL rather than
  // find nothing — before bot.catch existed, that took the whole bot down.
  it.each([
    ['malformed', 'offer_not-a-uuid'],
    ['truncated', `offer_${TICKET_ID.slice(0, 20)}`],
    ['hyphen-less', `offer_${TICKET_ID.replace(/-/g, '')}`],
  ])(
    'answers a %s ticket id as "not found" without querying',
    async (_kind, link) => {
      const { service, prisma } = build();
      const c = ctx();

      expect(await service.startFromDeepLink(c, link)).toBe(true); // consumed
      expect(prisma.sourcingTicket.findUnique).not.toHaveBeenCalled();
      expect(c.reply).toHaveBeenCalledTimes(1);
      expect(c.reply.mock.calls[0][0]).toBe(
        'Заявка не найдена — возможно, она уже закрыта.',
      );
      // No session was opened: the next text is not an offer price.
      expect(await service.handleText(ctx('250000'))).toBe(false);
    },
  );

  it('answers a well-formed id that matches no ticket as "not found"', async () => {
    const { service, prisma } = build();
    prisma.sourcingTicket.findUnique.mockResolvedValueOnce(null as never);
    const c = ctx();

    expect(await service.startFromDeepLink(c, OFFER_LINK)).toBe(true);
    expect(prisma.sourcingTicket.findUnique).toHaveBeenCalledTimes(1);
    expect(c.reply.mock.calls[0][0]).toBe(
      'Заявка не найдена — возможно, она уже закрыта.',
    );
  });

  it('does not consume text when there is no active session', async () => {
    const { service } = build();
    expect(await service.handleText(ctx('250000'))).toBe(false);
  });

  it('rejects an unparseable price and re-prompts', async () => {
    const { service } = build();
    await service.startFromDeepLink(ctx(), OFFER_LINK);
    const c = ctx('сколько?');
    expect(await service.handleText(c)).toBe(true);
    expect(c.reply.mock.calls[0][0]).toContain('числом');
  });

  it('captures a price-only offer (no photo) end to end', async () => {
    const { service, offers } = build();
    await service.startFromDeepLink(ctx(), OFFER_LINK);
    await service.handleText(ctx('250000')); // PRICE → CONDITION
    await (service as any).finalize(ctx());

    expect(offers.createOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: TICKET_ID,
        price: 250000,
        images: [],
        condition: 'UNKNOWN',
        sellerTgId: '42',
        sellerUsername: 'ali_dealer',
      }),
    );
  });

  it('uploads a photo and includes it in the offer', async () => {
    const { service, offers, telegramFile, cloudinary } = build();
    const fetchMock = jest
      .spyOn(global, 'fetch' as never)
      .mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as never);

    await service.startFromDeepLink(ctx(), OFFER_LINK);
    await service.handleText(ctx('300000'));
    const photoConsumed = await service.handlePhoto(ctx(), 'file-abc');
    await (service as any).finalize(ctx());

    expect(photoConsumed).toBe(true);
    expect(telegramFile.getFileUrl).toHaveBeenCalledWith('file-abc');
    expect(cloudinary.uploadBuffer).toHaveBeenCalled();
    expect(offers.createOffer).toHaveBeenCalledWith(
      expect.objectContaining({ price: 300000, images: ['https://cdn/x.png'] }),
    );
    fetchMock.mockRestore();
  });

  it('will not accept a photo before a price', async () => {
    const { service, telegramFile } = build();
    await service.startFromDeepLink(ctx(), OFFER_LINK);
    const c = ctx();
    const consumed = await service.handlePhoto(c, 'file-abc');
    expect(consumed).toBe(true); // consumed (session active) but rejected
    expect(telegramFile.getFileUrl).not.toHaveBeenCalled();
    expect(c.reply.mock.calls[0][0]).toContain('цену');
  });

  it('refuses a closed ticket', async () => {
    const prisma = {
      sourcingTicket: { findUnique: jest.fn(async () => ({ ...TICKET, status: 'CLOSED' })) },
    };
    const service = new TelegramOfferService(
      prisma as never,
      { createOffer: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    const c = ctx();
    expect(await service.startFromDeepLink(c, OFFER_LINK)).toBe(true);
    expect(c.reply.mock.calls[0][0]).toContain('закрыта');
  });
});

// The offer flow's inline screens are answered once, so each is retired on tap
// — the same rule the product wizard follows. Cleanup is cosmetic: a Telegram
// refusal must never cost the seller their offer.
describe('TelegramOfferService — callback screen cleanup', () => {
  /** A callback ctx recording what the tap did to its own message. */
  function cbCtx(deleteBehaviour: 'ok' | 'throws' = 'ok') {
    const rec = { deleted: false, keyboardStripped: false };
    return {
      rec,
      ctx: {
        from: { id: 42, first_name: 'Ali', username: 'ali_dealer' },
        match: ['sof:cond:NEW', 'NEW'],
        answerCbQuery: jest.fn().mockResolvedValue(true),
        reply: jest.fn().mockResolvedValue(undefined),
        deleteMessage: jest.fn(async () => {
          if (deleteBehaviour === 'throws') {
            throw new Error("400: Bad Request: message can't be deleted");
          }
          rec.deleted = true;
          return true;
        }),
        editMessageReplyMarkup: jest.fn(async () => {
          rec.keyboardStripped = true;
          return {};
        }),
      } as any,
    };
  }

  /** Register the flow's actions against a fake bot and dispatch by data. */
  function wire(service: TelegramOfferService) {
    const handlers: { match: RegExp | string; fn: (c: any) => Promise<void> }[] =
      [];
    service.registerActions({
      action: (match: RegExp | string, fn: (c: any) => Promise<void>) =>
        handlers.push({ match, fn }),
    } as never);
    return (data: string, c: any) => {
      const e = handlers.find(({ match }) =>
        match instanceof RegExp ? match.test(data) : match === data,
      );
      if (!e) throw new Error(`no handler for "${data}"`);
      c.match = e.match instanceof RegExp ? e.match.exec(data) : [data];
      return e.fn(c);
    };
  }

  it('deletes the condition screen and moves on to photos', async () => {
    const { service } = build();
    const tap = wire(service);
    await service.startFromDeepLink(ctx(), OFFER_LINK);
    await service.handleText(ctx('250000')); // PRICE → CONDITION

    const { ctx: c, rec } = cbCtx();
    await tap('sof:cond:NEW', c);

    expect(rec.deleted).toBe(true);
    expect(c.reply.mock.calls[0][0]).toContain('фото');
  });

  it('deletes the submit screen once the offer is recorded', async () => {
    const { service, offers } = build();
    const tap = wire(service);
    await service.startFromDeepLink(ctx(), OFFER_LINK);
    await service.handleText(ctx('250000'));

    const { ctx: c, rec } = cbCtx();
    await tap('sof:submit', c);

    expect(offers.createOffer).toHaveBeenCalledTimes(1);
    expect(rec.deleted).toBe(true);
  });

  it('does NOT delete when submit is rejected for a missing price', async () => {
    const { service, offers } = build();
    const tap = wire(service);
    await service.startFromDeepLink(ctx(), OFFER_LINK); // no price yet

    const { ctx: c, rec } = cbCtx();
    await tap('sof:submit', c);

    // Validation bounce: the seller keeps the screen they must act on.
    expect(offers.createOffer).not.toHaveBeenCalled();
    expect(rec.deleted).toBe(false);
    expect(c.reply.mock.calls[0][0]).toContain('цену');
  });

  it('records the offer even when Telegram refuses the delete', async () => {
    const { service, offers } = build();
    const tap = wire(service);
    await service.startFromDeepLink(ctx(), OFFER_LINK);
    await service.handleText(ctx('250000'));

    const { ctx: c, rec } = cbCtx('throws');
    await tap('sof:submit', c);

    expect(offers.createOffer).toHaveBeenCalledTimes(1);
    expect(rec.deleted).toBe(false);
    expect(rec.keyboardStripped).toBe(true);
  });

  it('deletes the screen on cancel and clears the session', async () => {
    const { service } = build();
    const tap = wire(service);
    await service.startFromDeepLink(ctx(), OFFER_LINK);

    const { ctx: c, rec } = cbCtx();
    await tap('sof:cancel', c);

    expect(rec.deleted).toBe(true);
    // Session gone: further text is no longer consumed by the offer flow.
    expect(await service.handleText(ctx('250000'))).toBe(false);
  });
});
