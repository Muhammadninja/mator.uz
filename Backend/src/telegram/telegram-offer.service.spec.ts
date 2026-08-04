// Unit tests for the "У меня есть" DM offer-capture flow.
//
// Contract pinned here:
//   • a valid deep-link opens a session and asks for price
//   • a non-offer /start payload is ignored (passthrough → false)
//   • text/photos are only consumed while a session is active
//   • price is required; photo is optional (price-only offer is valid)
//   • finalize records the offer with the seller's Telegram identity

import { TelegramOfferService } from './telegram-offer.service';

const TICKET = {
  id: 'ticket-1',
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
    const consumed = await service.startFromDeepLink(c, 'offer_ticket-1');
    expect(consumed).toBe(true);
    expect(prisma.sourcingTicket.findUnique).toHaveBeenCalled();
    expect(c.reply.mock.calls[0][0]).toContain('цену');
  });

  it('does not consume text when there is no active session', async () => {
    const { service } = build();
    expect(await service.handleText(ctx('250000'))).toBe(false);
  });

  it('rejects an unparseable price and re-prompts', async () => {
    const { service } = build();
    await service.startFromDeepLink(ctx(), 'offer_ticket-1');
    const c = ctx('сколько?');
    expect(await service.handleText(c)).toBe(true);
    expect(c.reply.mock.calls[0][0]).toContain('числом');
  });

  it('captures a price-only offer (no photo) end to end', async () => {
    const { service, offers } = build();
    await service.startFromDeepLink(ctx(), 'offer_ticket-1');
    await service.handleText(ctx('250000')); // PRICE → CONDITION
    await (service as any).finalize(ctx());

    expect(offers.createOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'ticket-1',
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

    await service.startFromDeepLink(ctx(), 'offer_ticket-1');
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
    await service.startFromDeepLink(ctx(), 'offer_ticket-1');
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
    expect(await service.startFromDeepLink(c, 'offer_ticket-1')).toBe(true);
    expect(c.reply.mock.calls[0][0]).toContain('закрыта');
  });
});
