// LOW-ORD-007 (offer and service lines) and LOW-ORD-009 (provider attribution).

import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { findUnavailableParts } from './order-availability';
import { findUnavailableForPayment } from './inventory/payment-availability';
import { CartService } from '../cart/cart.service';
import { AddCartItemDto } from '../cart/dto/add-cart-item.dto';

function db(over: {
  offers?: unknown[];
  sellers?: unknown[];
  services?: unknown[];
}) {
  return {
    catalogPart: { findMany: jest.fn().mockResolvedValue([]) },
    partCategory: { findMany: jest.fn().mockResolvedValue([]) },
    sourcingOffer: { findMany: jest.fn().mockResolvedValue(over.offers ?? []) },
    seller: { findMany: jest.fn().mockResolvedValue(over.sellers ?? []) },
    providerServiceOffering: {
      findMany: jest.fn().mockResolvedValue(over.services ?? []),
    },
  };
}

const offer = (over: Record<string, unknown> = {}) => ({
  id: 'soff_1',
  status: 'ACCEPTED',
  sellerTgId: '777',
  ticket: { status: 'ACCEPTED' },
  ...over,
});
const service = (over: Record<string, unknown> = {}) => ({
  id: 'svc_1',
  providerId: 'prov_1',
  priceUzs: 50_000,
  provider: { isActive: true },
  ...over,
});
const offerLine = (quantity = 1) => ({
  partId: null,
  offerId: 'soff_1',
  title: 'Starter',
  quantity,
});
const serviceLine = (providerId: string | null = 'prov_1', quantity = 1) => ({
  partId: null,
  serviceId: 'svc_1',
  providerId,
  title: 'Oil change',
  quantity,
});

describe('offer lines', () => {
  it('a live accepted offer from an eligible seller is sellable', async () => {
    expect(
      await findUnavailableParts(db({ offers: [offer()] }) as never, [
        offerLine(),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['expired', offer({ status: 'EXPIRED' })],
    ['declined', offer({ status: 'DECLINED' })],
    ['never accepted', offer({ status: 'SENT' })],
    ['on a cancelled ticket', offer({ ticket: { status: 'CANCELLED' } })],
    ['on a closed ticket', offer({ ticket: { status: 'CLOSED' } })],
  ])('an offer that is %s cannot be ordered', async (_what, row) => {
    const result = await findUnavailableParts(db({ offers: [row] }) as never, [
      offerLine(),
    ]);
    expect(result).toEqual([
      { partId: 'soff_1', title: 'Starter', reason: 'offer_unavailable' },
    ]);
  });

  it('a deleted offer cannot be ordered', async () => {
    const result = await findUnavailableParts(db({}) as never, [offerLine()]);
    expect(result[0].reason).toBe('offer_unavailable');
  });

  it('an offer from a rejected (banned) seller cannot be ordered', async () => {
    const result = await findUnavailableParts(
      db({
        offers: [offer()],
        sellers: [{ tgId: 777n, status: 'REJECTED' }],
      }) as never,
      [offerLine()],
    );
    expect(result[0].reason).toBe('seller_ineligible');
  });

  it('a one-off offer cannot be ordered as two', async () => {
    const result = await findUnavailableParts(
      db({ offers: [offer()] }) as never,
      [offerLine(2)],
    );
    expect(result[0].reason).toBe('invalid_quantity');
  });
});

describe('service lines', () => {
  it('a service of an active provider, attributed to that provider, is sellable', async () => {
    expect(
      await findUnavailableParts(db({ services: [service()] }) as never, [
        serviceLine(),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['removed', [], 'service_unavailable'],
    [
      'offered by an inactive provider',
      [service({ provider: { isActive: false } })],
      'service_unavailable',
    ],
  ])('a service %s cannot be ordered', async (_what, rows, reason) => {
    const result = await findUnavailableParts(db({ services: rows }) as never, [
      serviceLine(),
    ]);
    expect(result[0].reason).toBe(reason);
  });

  it('a line attributed to another provider is refused, so money cannot be routed to it', async () => {
    const result = await findUnavailableParts(
      db({ services: [service()] }) as never,
      [serviceLine('prov_attacker')],
    );
    expect(result[0].reason).toBe('provider_mismatch');
  });

  it('a service cannot be booked twice on one line', async () => {
    const result = await findUnavailableParts(
      db({ services: [service()] }) as never,
      [serviceLine('prov_1', 3)],
    );
    expect(result[0].reason).toBe('invalid_quantity');
  });

  it('normal part lines keep their own rules (no stock checks for offers or services)', async () => {
    const prisma = db({ services: [service()], offers: [offer()] });
    await findUnavailableParts(prisma as never, [offerLine(), serviceLine()]);
    expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
  });
});

describe('payment re-checks every line type', () => {
  it('an order whose offer was cancelled after ordering cannot be paid', async () => {
    const prisma = {
      ...db({ offers: [offer({ ticket: { status: 'CANCELLED' } })] }),
      orderItem: { findMany: jest.fn().mockResolvedValue([offerLine()]) },
      inventoryReservation: { findMany: jest.fn().mockResolvedValue([]) },
      payment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const result = await findUnavailableForPayment(prisma as never, 'ord_1');
    expect(result.map((r) => r.reason)).toEqual(['offer_unavailable']);
    const select = (prisma.orderItem.findMany.mock.calls[0] as any)[0].select;
    expect(select).toMatchObject({
      offerId: true,
      serviceId: true,
      providerId: true,
    });
  });
});

describe('CartService', () => {
  function cartWith(items: unknown[], svc?: unknown) {
    const prisma = {
      cart: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: 'cart_1', userId: 'u1', items }),
      },
      cartItem: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findFirst: jest.fn(async () => items[0]),
        findUnique: jest.fn(async () => ({
          ...(items[0] as object),
          cart: { userId: 'u1' },
        })),
      },
      providerServiceOffering: {
        findUnique: jest.fn().mockResolvedValue(svc ?? null),
      },
      vehicle: { findFirst: jest.fn() },
    };
    const service = new CartService(prisma as never, {} as never);
    jest.spyOn(service, 'snapshot').mockResolvedValue({} as never);
    return { service, prisma };
  }

  it('stores the provider of the service, ignoring nothing and trusting no client value', async () => {
    const { service, prisma } = cartWith([], {
      id: 'svc_1',
      name: 'Oil change',
      priceUzs: 50_000,
      providerId: 'prov_1',
      provider: { isActive: true },
    });
    await service.addItem('u1', { service_id: 'svc_1' });
    expect(prisma.cartItem.create.mock.calls[0][0].data.providerId).toBe(
      'prov_1',
    );
  });

  it("refuses a client provider_id that is not the service's provider", async () => {
    const { service, prisma } = cartWith([], {
      id: 'svc_1',
      name: 'Oil change',
      priceUzs: 50_000,
      providerId: 'prov_1',
      provider: { isActive: true },
    });
    await expect(
      service.addItem('u1', { service_id: 'svc_1', provider_id: 'prov_2' }),
    ).rejects.toMatchObject({ response: { code: 'PROVIDER_MISMATCH' } });
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('refuses a service of an inactive provider', async () => {
    const { service } = cartWith([], {
      id: 'svc_1',
      providerId: 'prov_1',
      provider: { isActive: false },
    });
    await expect(
      service.addItem('u1', { service_id: 'svc_1' }),
    ).rejects.toThrow('Service not found');
  });

  it.each([
    ['offer', { id: 'ci_1', offerId: 'soff_1', partId: null, serviceId: null }],
    [
      'service',
      { id: 'ci_1', serviceId: 'svc_1', partId: null, offerId: null },
    ],
  ])(
    'a %s line cannot be multiplied through PATCH quantity',
    async (_kind, item) => {
      const { service, prisma } = cartWith([item]);
      jest
        .spyOn(service as any, 'assertItemOwned')
        .mockResolvedValue(item as never);
      await expect(service.updateItem('u1', 'ci_1', 5)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.cartItem.update).not.toHaveBeenCalled();
    },
  );
});

describe('scheduled_at', () => {
  const errors = async (scheduled_at: unknown) =>
    (
      await validate(
        plainToInstance(AddCartItemDto, { service_id: 's', scheduled_at }),
      )
    ).map((e) => e.property);

  it('accepts an ISO date-time', async () => {
    expect(await errors('2026-11-20T10:30:00+05:00')).toEqual([]);
    expect(await errors('2026-11-20T05:30:00.000Z')).toEqual([]);
  });

  it.each([
    'tomorrow',
    '2026-13-40T99:00:00Z',
    '2026-02-30T10:00:00Z',
    '20261120',
    'null',
  ])('rejects %j with 400 instead of a database 500', async (value) => {
    expect(await errors(value)).toEqual(['scheduled_at']);
  });
});
