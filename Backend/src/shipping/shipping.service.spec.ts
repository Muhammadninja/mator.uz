// What a client hears from POST /v1/shipping/quote, and what it cannot say to it.

import { ValidationPipe } from '@nestjs/common';
import { ShippingQuoteDto } from './dto/shipping-quote.dto';
import { ShippingService } from './shipping.service';

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
    service = new ShippingService(quotes as never);
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

  it('tells the buyer the price and nothing else about the route', async () => {
    const res = await service.quote('usr_1', {
      delivery_address_id: 'addr_1',
      delivery_method: 'courier',
    });

    expect(res).toEqual({
      options: [
        {
          type: 'courier',
          label: 'Kuryer',
          price_uzs: 24_000,
          quote_id: 'quote_1',
        },
      ],
      currency: 'UZS',
    });
    expect(JSON.stringify(res)).not.toMatch(
      /distance|duration|billable|eta|geometry|route|shipment|pickup|destination|landmark|41\.|69\./i,
    );
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

  it('lets a refusal through rather than answering with a price', async () => {
    quotes.quoteCart.mockRejectedValue(new Error('refused'));
    await expect(
      service.quote('usr_1', {
        delivery_address_id: 'addr_1',
        delivery_method: 'courier',
      }),
    ).rejects.toThrow('refused');
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
});
