/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- reads the arguments of a jest spy, which are untyped */
// The UzMaps reverse geocoding adapter, against the response documented at
// https://docs.uzmaps.uz/http-search/. axios is stubbed, so nothing reaches the network.

import { Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { ReverseGeocodingUnavailableError } from './reverse-geocoding-provider';
import { UzmapsReverseGeocodingProvider } from './uzmaps-reverse-geocoding.provider';

const KEY = 'secret-uzmaps-key';
const POINT = { lat: 41.2995, lng: 69.2401 };

const provider = (
  env: Record<string, string> = { UZMAPS_API_KEY: KEY },
  metrics?: { recordUzmapsRequest: jest.Mock },
) =>
  new UzmapsReverseGeocodingProvider(
    { get: (key: string) => env[key] } as never,
    metrics as never,
  );

const answered = (data: unknown) => ({ data }) as AxiosResponse;

/** The example in the docs, cut to what is read. */
const DOCUMENTED = {
  address: {
    street: "Seul ko'chasi",
    neighbourhood: 'Charx Kamolon-1 mahallasi',
    city: 'Toshkent',
    district: 'Chilonzor Tumani',
  },
  label: "Seul ko'chasi, Chilonzor Tumani, Toshkent",
  lat: 41.2995,
  lon: 69.2401,
  short: "Seul ko'chasi",
};

describe('UzmapsReverseGeocodingProvider', () => {
  let get: jest.SpyInstance;
  let logged: string[];

  beforeEach(() => {
    get = jest.spyOn(axios, 'get');
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((line: unknown) => {
          logged.push(String(line));
        });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks about the point, in separate lat and lon, and nothing else', async () => {
    get.mockResolvedValue(answered(DOCUMENTED));

    await provider().describe(POINT, 'ru');

    const [url, options] = get.mock.calls[0];
    expect(url).toBe('https://uzmaps.uz/api/reverse');
    expect(options.params).toEqual({
      lat: 41.2995,
      lon: 69.2401,
      lang: 'ru',
    });
    expect(options.headers).toEqual({ 'X-API-Key': KEY });
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('reads the documented answer', async () => {
    get.mockResolvedValue(answered(DOCUMENTED));

    await expect(provider().describe(POINT, 'en')).resolves.toEqual({
      city: 'Toshkent',
      district: 'Chilonzor Tumani',
      street: "Seul ko'chasi",
      house: null,
    });
  });

  it('keeps a house number when there is one', async () => {
    get.mockResolvedValue(
      answered({
        address: { street: 'Navoiy', housenumber: '5', city: 'Toshkent' },
      }),
    );

    await expect(provider().describe(POINT, 'uz')).resolves.toMatchObject({
      street: 'Navoiy',
      house: '5',
    });
  });

  it('uses the neighbourhood where there is no street, and the region where no city', async () => {
    get.mockResolvedValue(
      answered({
        address: {
          neighbourhood: 'Charx Kamolon',
          region: 'Toshkent viloyati',
        },
      }),
    );

    await expect(provider().describe(POINT, 'uz')).resolves.toMatchObject({
      street: 'Charx Kamolon',
      city: 'Toshkent viloyati',
    });
  });

  it.each(['Dropped pin', 'Точка на карте', 'Xaritadagi nuqta'])(
    'finding nothing is nothing: %p is never taken for an address',
    async (label) => {
      get.mockResolvedValue(
        answered({ address: {}, label, short: label, lat: 41.3, lon: 69.2 }),
      );
      await expect(provider().describe(POINT, 'en')).resolves.toBeNull();
    },
  );

  it.each([[{}], [null], [''], [{ address: null }]])(
    'an answer with no address (%j) is nothing too',
    async (body) => {
      get.mockResolvedValue(answered(body));
      await expect(provider().describe(POINT, 'en')).resolves.toBeNull();
    },
  );

  it.each([
    [400, { error: 'lat and lon required' }],
    [401, { message: 'unknown API key' }],
    [429, { message: 'rate limit exceeded' }],
    [503, { error: 'search index not built' }],
  ])('HTTP %i gives no answer', async (status, data) => {
    get.mockRejectedValue(
      new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status,
        data,
      } as AxiosResponse),
    );
    await expect(provider().describe(POINT, 'en')).rejects.toBeInstanceOf(
      ReverseGeocodingUnavailableError,
    );
  });

  it('no key: UzMaps is not even called', async () => {
    await expect(provider({}).describe(POINT, 'en')).rejects.toBeInstanceOf(
      ReverseGeocodingUnavailableError,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('uses the search key when there is one', async () => {
    get.mockResolvedValue(answered(DOCUMENTED));
    await provider({
      UZMAPS_API_KEY: 'routing',
      UZMAPS_SEARCH_API_KEY: 'search',
    }).describe(POINT, 'en');
    expect(get.mock.calls[0][1].headers['X-API-Key']).toBe('search');
  });

  it('after a failure, neither the log nor the error holds the key or the point', async () => {
    get.mockRejectedValue(
      new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 401,
        data: { message: 'unknown API key' },
      } as AxiosResponse),
    );

    const error = (await provider()
      .describe(POINT, 'en')
      .catch((err: unknown) => err)) as Error;

    const text = [...logged, error.message].join('\n');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('41.29');
    expect(text).not.toContain('69.24');
  });

  it('counts itself as geocoding, a product of its own', async () => {
    const metrics = { recordUzmapsRequest: jest.fn() };
    get.mockResolvedValue(answered(DOCUMENTED));
    await provider({ UZMAPS_API_KEY: KEY }, metrics).describe(POINT, 'en');
    expect(metrics.recordUzmapsRequest).toHaveBeenCalledWith(
      'geocoding',
      'success',
    );
  });
});
