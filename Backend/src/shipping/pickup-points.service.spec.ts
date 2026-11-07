// Where a buyer who collects the order goes: each dealer the cart buys from, its own address
// and location, and its own lines. The tables below answer each query by its real `where`
// (where-eval), so a dealer that is not asked for cannot turn up by accident.

import { matchesWhere } from '../catalog/compatibility/where-eval.test-util';
import {
  CartPickupItem,
  PickupPoint,
  PickupPointsService,
  findPickupPoints,
  presentCartPickupPoint,
} from './pickup-points.service';
import { ShippingController } from './shipping.controller';

type Row = Record<string, unknown>;

/** A table that answers findMany by its `where`, as the database would. */
const table = (rows: Row[]) =>
  jest.fn((args?: { where?: unknown }) =>
    Promise.resolve(rows.filter((row) => matchesWhere(row, args?.where))),
  );

const STOREFRONTS: Row[] = [
  // The id the projection once recorded points at another seller: the operator's link wins.
  { id: 'drivers-village', name: 'Driver’s Village', internalSellerId: 3 },
  { id: 'seller_7', name: 'Avto Ehtiyot', internalSellerId: 7 },
  { id: 'seller_9', name: 'Chilonzor Parts', internalSellerId: 9 },
  { id: 'seller_4', name: 'Nuqtasiz Savdo', internalSellerId: 4 },
];

const SELLERS: Row[] = [
  {
    id: 5,
    tgId: null,
    phone: '+998900000005',
    catalogSellerId: 'drivers-village',
    storeName: 'DV',
    marketName: null,
    addressComment: 'Toshkent, Bunyodkor shoh ko‘chasi 12',
    locationLat: 41.2851,
    locationLng: 69.2045,
  },
  {
    id: 3,
    tgId: BigInt(3003),
    phone: '+998900000003',
    catalogSellerId: null,
    storeName: 'Old listing',
    marketName: null,
    addressComment: 'Not the dealer’s place',
    locationLat: 40.1,
    locationLng: 65.1,
  },
  {
    id: 7,
    tgId: BigInt(7007),
    phone: '+998900000007',
    catalogSellerId: null,
    storeName: 'Avto Ehtiyot',
    marketName: 'Sergeli',
    addressComment: 'Sergeli avtobozori, 3-qator 25',
    locationLat: 41.2263,
    locationLng: 69.219,
  },
  {
    id: 9,
    tgId: BigInt(9009),
    phone: '+998900000009',
    catalogSellerId: null,
    storeName: 'Chilonzor Parts',
    marketName: null,
    addressComment: 'Chilonzor 9-kvartal',
    locationLat: 41.2756,
    locationLng: 69.2034,
  },
  {
    id: 4,
    tgId: BigInt(4004),
    phone: '+998900000004',
    catalogSellerId: null,
    storeName: 'Nuqtasiz Savdo',
    marketName: null,
    addressComment: '   ',
    locationLat: null,
    locationLng: null,
  },
  {
    // A Telegram seller whose only goods so far are an accepted offer: no storefront row.
    id: 11,
    tgId: BigInt(1111),
    phone: '+998900000011',
    catalogSellerId: null,
    storeName: 'Usta Bahodir',
    marketName: null,
    addressComment: null,
    locationLat: 41.33,
    locationLng: 69.3,
  },
];

const PARTS: Row[] = [
  { id: 'part_dv_1', sellerId: 'drivers-village' },
  { id: 'part_dv_2', sellerId: 'drivers-village' },
  { id: 'part_7_1', sellerId: 'seller_7' },
  { id: 'part_9_1', sellerId: 'seller_9' },
  { id: 'part_4_1', sellerId: 'seller_4' },
];

const line = (
  id: string,
  over: Partial<{
    partId: string | null;
    offerId: string | null;
    serviceId: string | null;
    title: string;
    quantity: number;
    offer: { sellerTgId: string } | null;
  }> = {},
) => ({
  id,
  partId: null,
  offerId: null,
  serviceId: null,
  title: `Line ${id}`,
  quantity: 1,
  offer: null,
  ...over,
});

function world(
  cartLines: ReturnType<typeof line>[] | null,
  overrides: { sellers?: Row[]; storefronts?: Row[]; parts?: Row[] } = {},
) {
  return {
    cart: {
      findUnique: jest.fn(() =>
        Promise.resolve(cartLines ? { items: cartLines } : null),
      ),
    },
    catalogPart: { findMany: table(overrides.parts ?? PARTS) },
    catalogSeller: { findMany: table(overrides.storefronts ?? STOREFRONTS) },
    seller: { findMany: table(overrides.sellers ?? SELLERS) },
  };
}

const pointsFor = (
  cartLines: ReturnType<typeof line>[] | null,
  overrides?: Parameters<typeof world>[1],
) => {
  const prisma = world(cartLines, overrides);
  return {
    prisma,
    points: new PickupPointsService(prisma as never).forCart('usr_1'),
  };
};

const item = (
  cartItemId: string,
  partId: string | null,
  quantity = 1,
): CartPickupItem => ({
  cartItemId,
  partId,
  title: `Line ${cartItemId}`,
  quantity,
});

describe('Pickup points for the checkout', () => {
  it("one part of one dealer: that dealer's name, address and location, with the line", async () => {
    const { points } = pointsFor([
      line('ci_1', { partId: 'part_7_1', quantity: 2 }),
    ]);

    expect(await points).toEqual([
      {
        dealerId: 'seller_7',
        dealerName: 'Avto Ehtiyot',
        address: 'Sergeli avtobozori, 3-qator 25',
        landmark: null,
        location: { lat: 41.2263, lng: 69.219 },
        items: [item('ci_1', 'part_7_1', 2)],
      },
    ]);
  });

  it('several parts of one dealer: one point, its address once, every line under it', async () => {
    const { points } = pointsFor([
      line('ci_1', { partId: 'part_dv_1' }),
      line('ci_2', { partId: 'part_dv_2', quantity: 3 }),
    ]);

    const result = await points;
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      dealerId: 'drivers-village',
      dealerName: 'Driver’s Village',
      address: 'Toshkent, Bunyodkor shoh ko‘chasi 12',
      landmark: null,
      location: { lat: 41.2851, lng: 69.2045 },
      items: [item('ci_1', 'part_dv_1'), item('ci_2', 'part_dv_2', 3)],
    });
  });

  it('parts of two dealers: a point each, with its own lines, in the order of the cart', async () => {
    const { points } = pointsFor([
      line('ci_1', { partId: 'part_7_1' }),
      line('ci_2', { partId: 'part_dv_1' }),
      line('ci_3', { partId: 'part_7_1' }),
    ]);

    const result = await points;
    expect(result.map((p) => p.dealerId)).toEqual([
      'seller_7',
      'drivers-village',
    ]);
    expect(result[0].items.map((i) => i.cartItemId)).toEqual(['ci_1', 'ci_3']);
    expect(result[0].location).toEqual({ lat: 41.2263, lng: 69.219 });
    expect(result[1].items.map((i) => i.cartItemId)).toEqual(['ci_2']);
    expect(result[1].location).toEqual({ lat: 41.2851, lng: 69.2045 });
  });

  describe("no other dealer's place", () => {
    it('reads out only the dealers in the cart, and only what the buyer needs', async () => {
      const { points, prisma } = pointsFor([
        line('ci_1', { partId: 'part_dv_1' }),
        line('ci_2', { partId: 'part_7_1' }),
      ]);

      const json = JSON.stringify(await points);
      // Chilonzor Parts sells nothing in this cart.
      expect(json).not.toContain('Chilonzor');
      expect(json).not.toContain('41.2756');
      expect(json).not.toContain('seller_9');
      // Nor the seller behind a contact or a Telegram account.
      expect(json).not.toMatch(/\+998|tgId|phone|7007/);
      // Asked only about the cart's own storefronts.
      expect(prisma.catalogSeller.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['drivers-village', 'seller_7'] } },
        }),
      );
    });

    it('takes the seller the operator linked, never another one that matches, as courier delivery does', async () => {
      // drivers-village still records internal seller 3, whose old listing is elsewhere.
      const { points } = pointsFor([line('ci_1', { partId: 'part_dv_1' })]);

      const [point] = await points;
      expect(point.address).toBe('Toshkent, Bunyodkor shoh ko‘chasi 12');
      expect(point.location).toEqual({ lat: 41.2851, lng: 69.2045 });
      expect(JSON.stringify(point)).not.toContain('Not the dealer');
    });

    it('a dealer with no seller found has no point, not a neighbour’s', async () => {
      const { points } = pointsFor([line('ci_1', { partId: 'part_7_1' })], {
        sellers: SELLERS.filter((s) => s.id !== 7),
      });

      expect(await points).toEqual([
        expect.objectContaining({
          dealerId: 'seller_7',
          dealerName: 'Avto Ehtiyot',
          address: null,
          location: null,
        }),
      ]);
    });
  });

  describe('a point not on record yet', () => {
    it('no coordinates and a blank address: both null, never a made-up point', async () => {
      const { points } = pointsFor([line('ci_1', { partId: 'part_4_1' })]);

      expect(await points).toEqual([
        {
          dealerId: 'seller_4',
          dealerName: 'Nuqtasiz Savdo',
          address: null,
          landmark: null,
          location: null,
          items: [item('ci_1', 'part_4_1')],
        },
      ]);
    });

    it.each([
      ['0, 0', 0, 0],
      ['latitude only', 41.3, null],
      ['out of range', 141.3, 69.2],
      ['not a number', Number.NaN, 69.2],
    ])('coordinates %s are no location', async (_label, lat, lng) => {
      const sellers = SELLERS.map((s) =>
        s.id === 7 ? { ...s, locationLat: lat, locationLng: lng } : s,
      );
      const { points } = pointsFor([line('ci_1', { partId: 'part_7_1' })], {
        sellers,
      });

      const [point] = await points;
      expect(point.location).toBeNull();
      // What is on record is still said.
      expect(point.address).toBe('Sergeli avtobozori, 3-qator 25');
    });

    it('an address with no location keeps the address, and the reverse', async () => {
      const sellers = SELLERS.map((s) =>
        s.id === 7
          ? { ...s, locationLat: null, locationLng: null }
          : s.id === 5
            ? { ...s, addressComment: null }
            : s,
      );
      const { points } = pointsFor(
        [
          line('ci_1', { partId: 'part_7_1' }),
          line('ci_2', { partId: 'part_dv_1' }),
        ],
        { sellers },
      );

      const [avto, dv] = await points;
      expect(avto).toMatchObject({
        address: 'Sergeli avtobozori, 3-qator 25',
        location: null,
      });
      expect(dv).toMatchObject({
        address: null,
        location: { lat: 41.2851, lng: 69.2045 },
      });
    });
  });

  describe('lines that are not a catalog part', () => {
    it('an accepted offer is collected from the Telegram seller who made it', async () => {
      const { points } = pointsFor([
        line('ci_1', { offerId: 'soff_1', offer: { sellerTgId: '1111' } }),
      ]);

      expect(await points).toEqual([
        {
          dealerId: 'seller_11',
          dealerName: 'Usta Bahodir',
          address: null,
          landmark: null,
          location: { lat: 41.33, lng: 69.3 },
          items: [item('ci_1', null)],
        },
      ]);
    });

    it("an offer from a seller with a storefront joins that dealer's point", async () => {
      const { points } = pointsFor([
        line('ci_1', { partId: 'part_7_1' }),
        line('ci_2', { offerId: 'soff_2', offer: { sellerTgId: '7007' } }),
      ]);

      const result = await points;
      expect(result).toHaveLength(1);
      expect(result[0].dealerId).toBe('seller_7');
      expect(result[0].items.map((i) => i.cartItemId)).toEqual([
        'ci_1',
        'ci_2',
      ]);
    });

    it('a service has nothing to collect, and an empty cart has no points', async () => {
      const services = pointsFor([line('ci_1', { serviceId: 'svc_1' })]);
      expect(await services.points).toEqual([]);
      expect(services.prisma.seller.findMany).not.toHaveBeenCalled();

      expect(await pointsFor([]).points).toEqual([]);
      expect(await pointsFor(null).points).toEqual([]);
    });

    it('a part that is gone: listed apart, last, with no dealer and no point', async () => {
      const { points } = pointsFor([
        line('ci_1', { partId: 'part_removed' }),
        line('ci_2', { partId: 'part_7_1' }),
      ]);

      const result = await points;
      expect(result.map((p) => p.dealerId)).toEqual(['seller_7', null]);
      expect(result[1]).toEqual({
        dealerId: null,
        dealerName: null,
        address: null,
        landmark: null,
        location: null,
        items: [item('ci_1', 'part_removed')],
      });
    });

    it('an offer whose seller is not found is not given a dealer', async () => {
      const { points } = pointsFor([
        line('ci_1', { offerId: 'soff_3', offer: { sellerTgId: '424242' } }),
      ]);

      expect(await points).toEqual([
        expect.objectContaining({ dealerId: null, location: null }),
      ]);
    });
  });

  it('an order line names its dealer: the offer seller only stands in for that same storefront', async () => {
    // A line recorded under drivers-village, whose offer seller is someone else entirely,
    // never borrows that seller's place.
    const prisma = world([], {
      sellers: SELLERS.filter((s) => s.id !== 5 && s.id !== 3),
    });
    const points = await findPickupPoints(prisma as never, [
      {
        storefrontId: 'drivers-village',
        offerSellerTgId: '1111',
        item: 'oi_1',
      },
    ]);

    expect(points).toEqual([
      {
        dealerId: 'drivers-village',
        dealerName: 'Driver’s Village',
        address: null,
        landmark: null,
        location: null,
        items: ['oi_1'],
      },
    ]);
  });
});

describe('GET /v1/shipping/pickup-points', () => {
  const POINT: PickupPoint<CartPickupItem> = {
    dealerId: 'seller_7',
    dealerName: 'Avto Ehtiyot',
    address: 'Sergeli avtobozori, 3-qator 25',
    landmark: null,
    location: { lat: 41.2263, lng: 69.219 },
    items: [item('ci_1', 'part_7_1', 2)],
  };

  it('answers the caller’s own cart, in the snake_case the app reads', async () => {
    const pickupPoints = { forCart: jest.fn().mockResolvedValue([POINT]) };
    const controller = new ShippingController(
      {} as never,
      pickupPoints as never,
    );

    const res = await controller.pickupPointsOfCart({ user: { id: 'usr_1' } });

    expect(pickupPoints.forCart).toHaveBeenCalledWith('usr_1');
    expect(res).toEqual({
      pickup_points: [
        {
          dealer_id: 'seller_7',
          dealer_name: 'Avto Ehtiyot',
          address: 'Sergeli avtobozori, 3-qator 25',
          landmark: null,
          location: { lat: 41.2263, lng: 69.219 },
          items: [
            {
              cart_item_id: 'ci_1',
              part_id: 'part_7_1',
              title: 'Line ci_1',
              quantity: 2,
            },
          ],
        },
      ],
    });
  });

  it('a point not on record stays null on the wire', () => {
    expect(
      presentCartPickupPoint({ ...POINT, address: null, location: null }),
    ).toMatchObject({ address: null, landmark: null, location: null });
  });
});
