// What a client hears from POST /v1/shipping/quote, and what it cannot say to it.

import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  ValidationPipe,
} from '@nestjs/common';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';
import { COURIER_UNAVAILABLE_CODES, ShippingService } from './shipping.service';

const SHIPMENTS = [
  {
    sellerId: 1,
    pickup: { lat: 41.2995, lng: 69.2401 },
    tariffVersion: 'tariff_1',
    distanceMeters: 7_300,
    billableKm: 8,
    priceUzs: 24_000,
  },
];

describe('ShippingService.quote', () => {
  let quotes: { quoteCart: jest.Mock; coverage: unknown };
  let service: ShippingService;

  beforeEach(() => {
    quotes = {
      quoteCart: jest.fn().mockResolvedValue({
        priceUzs: 24_000,
        quoteId: 'quote_1',
        destination: {
          addressId: 'addr_1',
          lat: 41.3131,
          lng: 69.287,
          fullText: 'Amir Temur 12',
          landmark: 'Blue gate',
        },
        shipments: SHIPMENTS,
      }),
      coverage: null,
    };
    service = new ShippingService(
      quotes as never,
      { consume: jest.fn(async () => ({ allowed: true, retryAfter: 0 })) } as never,
      { get: () => undefined } as never,
    );
  });

  it('a build that names no method gets the answer it always had, whatever its address', async () => {
    const res = await service.quote('usr_1', {
      delivery_address_id: 'addr_without_coordinates',
    });

    expect(res).toEqual({
      options: [
        {
          type: 'pickup',
          label: 'Olib ketish',
          price_uzs: 0,
          eta_days_min: 0,
          eta_days_max: 0,
        },
      ],
      currency: 'UZS',
    });
    expect(quotes.quoteCart).not.toHaveBeenCalled();
  });

  it('prices a courier for the caller and the address they named', async () => {
    await service.quote('usr_1', {
      delivery_address_id: 'addr_1',
      delivery_method: 'courier',
    });
    expect(quotes.quoteCart).toHaveBeenCalledWith('usr_1', 'addr_1');
  });

  it('offers both: pickup, free, and the courier at the computed price', async () => {
    const res = await service.quote('usr_1', {
      delivery_address_id: 'addr_1',
      delivery_method: 'courier',
    });

    expect(res).toEqual({
      options: [
        {
          type: 'pickup',
          label: 'Olib ketish',
          available: true,
          price_uzs: 0,
          quote_id: null,
          unavailable_reason: null,
        },
        {
          type: 'courier',
          label: 'Kuryer',
          available: true,
          price_uzs: 24_000,
          quote_id: 'quote_1',
          unavailable_reason: null,
        },
      ],
      currency: 'UZS',
    });
  });

  it('tells the buyer the price and nothing else about the route', async () => {
    const res = await service.quote('usr_1', {
      delivery_address_id: 'addr_1',
      delivery_method: 'courier',
    });

    expect(JSON.stringify(res)).not.toMatch(
      /distance|duration|billable|eta|geometry|route|shipment|destination|landmark|41\.|69\./i,
    );
  });

  describe('a courier that cannot be had', () => {
    it.each([
      ['DELIVERY_ADDRESS_REQUIRED', UnprocessableEntityException],
      ['COURIER_DELIVERY_UNAVAILABLE', UnprocessableEntityException],
      ['DELIVERY_ADDRESS_COORDINATES_MISSING', UnprocessableEntityException],
      ['DELIVERY_OUTSIDE_COVERAGE', UnprocessableEntityException],
      ['PICKUP_LOCATION_MISSING', UnprocessableEntityException],
      ['DELIVERY_ROUTE_NOT_FOUND', UnprocessableEntityException],
      ['DELIVERY_ROUTING_UNAVAILABLE', ServiceUnavailableException],
    ])(
      '%s: offered as unavailable, with the reason, and pickup stays',
      async (code, Refusal) => {
        quotes.quoteCart.mockRejectedValue(new Refusal({ code, message: 'm' }));

        const res = await service.quote('usr_1', {
          delivery_address_id: 'addr_1',
          delivery_method: 'courier',
        });

        expect(res.options).toEqual([
          expect.objectContaining({
            type: 'pickup',
            available: true,
            price_uzs: 0,
          }),
          {
            type: 'courier',
            label: 'Kuryer',
            available: false,
            // Never a number: an unavailable courier is not a free one.
            price_uzs: null,
            quote_id: null,
            unavailable_reason: { code, message: 'm' },
          },
        ]);
        expect(res.currency).toBe('UZS');
      },
    );

    it('covers exactly the refusals about availability', () => {
      expect([...COURIER_UNAVAILABLE_CODES].sort()).toEqual(
        [
          'COURIER_DELIVERY_UNAVAILABLE',
          'DELIVERY_ADDRESS_COORDINATES_MISSING',
          'DELIVERY_ADDRESS_REQUIRED',
          'DELIVERY_OUTSIDE_COVERAGE',
          'DELIVERY_ROUTE_NOT_FOUND',
          'DELIVERY_ROUTING_UNAVAILABLE',
          'DELIVERY_TOO_MANY_SELLERS',
          'PICKUP_LOCATION_MISSING',
        ].sort(),
      );
    });
  });

  describe('coverage', () => {
    it('says so when no delivery area is configured, and names no place', () => {
      expect(service.coverage()).toEqual({
        configured: false,
        bounds: null,
        geometry: null,
      });
    });

    it('gives the very geometry enforced, and the box around it for the map to open on', () => {
      const polygons = [
        [
          [
            [69.1, 41.2],
            [69.4, 41.2],
            [69.4, 41.4],
            [69.1, 41.2],
          ],
        ],
      ];
      quotes.coverage = {
        polygons,
        bounds: { minLng: 69.1, minLat: 41.2, maxLng: 69.4, maxLat: 41.4 },
      };
      expect(service.coverage()).toEqual({
        configured: true,
        bounds: { min_lat: 41.2, min_lng: 69.1, max_lat: 41.4, max_lng: 69.4 },
        geometry: { type: 'MultiPolygon', coordinates: polygons },
      });
    });
  });

  it.each([
    ['a fault', new Error('refused')],
    ["someone else's address", new NotFoundException('Address not found')],
    ['an empty cart', new BadRequestException('Cart is empty')],
    [
      'a code that is not about availability',
      new UnprocessableEntityException({ code: 'SOMETHING_ELSE' }),
    ],
  ])('lets %s through rather than answering with options', async (_, err) => {
    quotes.quoteCart.mockRejectedValue(err);
    await expect(
      service.quote('usr_1', {
        delivery_address_id: 'addr_1',
        delivery_method: 'courier',
      }),
    ).rejects.toBe(err);
  });
});

describe('ShippingQuoteDto, under the global ValidationPipe', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const parse = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: ShippingQuoteDto });

  it('accepts what the installed and the current app send', async () => {
    await expect(
      parse({ delivery_address_id: 'addr_1' }),
    ).resolves.toBeDefined();
    await expect(
      parse({ delivery_address_id: 'addr_1', delivery_method: 'courier' }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['coordinates of its own', { destination: { lat: 41.3, lng: 69.2 } }],
    ['a price', { price_uzs: 1 }],
    ['a distance', { distance: 1 }],
    ['an unknown method', { delivery_method: 'teleport' }],
  ])('refuses a body stating %s', async (_, body) => {
    await expect(parse(body)).rejects.toBeDefined();
  });

  describe('the per-buyer quote limit (ORD-002)', () => {
    const body = { delivery_method: 'courier', delivery_address_id: 'addr_1' } as never;

    function limited(consume: jest.Mock) {
      return new ShippingService(
        { quoteCart: jest.fn() } as never,
        { consume } as never,
        { get: (k: string) => (k === 'DELIVERY_QUOTE_PER_MINUTE' ? '3' : undefined) } as never,
      );
    }

    it('refuses past the limit, keyed on the buyer and read from the environment', async () => {
      const consume = jest.fn(async () => ({ allowed: false, retryAfter: 42 }));
      await expect(limited(consume).quote('usr_1', body)).rejects.toMatchObject({
        status: 429,
        response: { code: 'DELIVERY_QUOTE_LIMITED' },
      });
      expect(consume).toHaveBeenCalledWith('rate:delivery:quote:usr_1', 3, 60);
    });

    it('a pickup-only answer costs nothing, so it is not counted', async () => {
      const consume = jest.fn();
      await limited(consume).quote('usr_1', {} as never);
      expect(consume).not.toHaveBeenCalled();
    });

    it('a limiter that cannot answer refuses the quote', async () => {
      const consume = jest.fn().mockRejectedValue(new Error('down'));
      await expect(limited(consume).quote('usr_1', body)).rejects.toThrow('down');
    });
  });
});
