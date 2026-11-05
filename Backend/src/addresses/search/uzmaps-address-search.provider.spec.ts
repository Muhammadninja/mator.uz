/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- reads the arguments of a jest spy, which are untyped */
// The UzMaps address search adapter, against https://docs.uzmaps.uz/http-search/. axios is
// stubbed, so nothing here reaches the network. The docs show no address-kind result, so
// these results follow their table of result fields.

import { Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosResponse } from 'axios';
import {
  AddressSearchQuery,
  AddressSearchUnavailableError,
} from './address-search-provider';
import { UzmapsAddressSearchProvider } from './uzmaps-address-search.provider';

const KEY = 'secret-uzmaps-key';
const QUERY: AddressSearchQuery = {
  street: 'Amir Temur',
  house: '12',
  language: 'ru',
  limit: 8,
  mode: 'autocomplete',
};
const BOUNDS = { minLng: 69.1, minLat: 41.2, maxLng: 69.4, maxLat: 41.4 };

const provider = (
  env: Record<string, string> = { UZMAPS_API_KEY: KEY },
  metrics?: { recordUzmapsRequest: jest.Mock },
) =>
  new UzmapsAddressSearchProvider(
    { get: (key: string) => env[key] } as never,
    metrics as never,
  );

const answered = (data: unknown) => ({ data }) as AxiosResponse;
const refused = (status: number, data: unknown) =>
  new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    { headers: { 'X-API-Key': KEY } } as never,
    undefined,
    { status, data } as AxiosResponse,
  );

const RESULT = {
  id: 77,
  kind: 'address',
  name: 'Amir Temur 12',
  label: 'Yunusobod, Toshkent',
  lat: 41.3111,
  lon: 69.2797,
  address: {
    street: 'Amir Temur',
    housenumber: '12',
    district: 'Yunusobod',
    city: 'Toshkent',
  },
};

describe('UzmapsAddressSearchProvider', () => {
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

  it('autocompletes while typing, and searches when asked to', async () => {
    get.mockResolvedValue(answered({ results: [] }));

    await provider().search(QUERY);
    await provider().search({ ...QUERY, mode: 'search' });

    expect(get.mock.calls[0][0]).toBe('https://uzmaps.uz/api/autocomplete');
    expect(get.mock.calls[1][0]).toBe('https://uzmaps.uz/api/search');
  });

  it('sends the text and nothing about who is asking', async () => {
    get.mockResolvedValue(answered({ results: [] }));

    await provider().search(QUERY);

    const [, options] = get.mock.calls[0];
    expect(options.params).toEqual({
      q: 'Amir Temur 12',
      lang: 'ru',
      limit: 8,
      kinds: 'address,street,place,poi',
    });
    expect(options.headers).toEqual({ 'X-API-Key': KEY });
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('adds the map context it is given: the area, and where the map is looking', async () => {
    get.mockResolvedValue(answered({ results: [] }));

    await provider().search({
      ...QUERY,
      bounds: BOUNDS,
      near: { lat: 41.31, lng: 69.28 },
    });

    expect(get.mock.calls[0][1].params).toMatchObject({
      bbox: '69.1,41.2,69.4,41.4',
      lat: 41.31,
      lon: 69.28,
    });
  });

  it('sends the street alone when no house is known', async () => {
    get.mockResolvedValue(answered({ results: [] }));

    await provider().search({ ...QUERY, house: undefined });

    expect(get.mock.calls[0][1].params.q).toBe('Amir Temur');
  });

  describe('which key', () => {
    beforeEach(() => get.mockResolvedValue(answered({ results: [] })));
    const usedKey = () => get.mock.calls[0][1].headers['X-API-Key'];

    it('its own, when there is one: search traffic then cannot use up routing', async () => {
      await provider({
        UZMAPS_API_KEY: 'routing',
        UZMAPS_SEARCH_API_KEY: 'search',
      }).search(QUERY);
      expect(usedKey()).toBe('search');
    });

    it('the one key, otherwise', async () => {
      await provider({
        UZMAPS_API_KEY: 'routing',
        UZMAPS_SEARCH_API_KEY: ' ',
      }).search(QUERY);
      expect(usedKey()).toBe('routing');
    });
  });

  it('turns [lat, lon] fields into a point and keeps the address parts', async () => {
    get.mockResolvedValue(answered({ results: [RESULT] }));

    await expect(provider().search(QUERY)).resolves.toEqual([
      {
        id: '77',
        title: 'Amir Temur 12',
        subtitle: 'Yunusobod, Toshkent',
        city: 'Toshkent',
        district: 'Yunusobod',
        street: 'Amir Temur',
        house: '12',
        lat: 41.3111,
        lng: 69.2797,
      },
    ]);
  });

  it('a street-level match says it has no house', async () => {
    get.mockResolvedValue(
      answered({
        results: [
          {
            ...RESULT,
            kind: 'street',
            name: 'Amir Temur',
            address: { street: 'Amir Temur', city: 'Toshkent' },
          },
        ],
      }),
    );

    const [found] = await provider().search(QUERY);

    expect(found.house).toBeNull();
    expect(found.title).toBe('Amir Temur');
  });

  it('falls back on the region where a place has no city', async () => {
    get.mockResolvedValue(
      answered({
        results: [{ ...RESULT, address: { region: 'Samarqand viloyati' } }],
      }),
    );

    const [found] = await provider().search(QUERY);

    expect(found.city).toBe('Samarqand viloyati');
    expect(found.street).toBeNull();
  });

  it.each([
    ['no coordinates', { ...RESULT, lat: undefined, lon: undefined }],
    ['half a point', { ...RESULT, lon: null }],
    ['0,0', { ...RESULT, lat: 0, lon: 0 }],
    ['coordinates that are text', { ...RESULT, lat: '41.3', lon: '69.2' }],
    ['no name at all', { ...RESULT, name: ' ', label: '' }],
    ['nothing', null],
  ])('skips a result with %s', async (_, bad) => {
    get.mockResolvedValue(answered({ results: [bad, RESULT] }));

    const found = await provider().search(QUERY);

    expect(found.map((address) => address.id)).toEqual(['77']);
  });

  it('nothing matching is an empty list, not a failure', async () => {
    get.mockResolvedValue(answered({ query: 'x', results: [], took_ms: 1 }));
    await expect(provider().search(QUERY)).resolves.toEqual([]);
  });

  describe('when no answer could be had', () => {
    it.each([
      ['no results field', {}],
      ['results that are not a list', { results: 'none' }],
      ['an empty body', ''],
      ['null', null],
    ])('a 200 with %s', async (_, body) => {
      get.mockResolvedValue(answered(body));
      await expect(provider().search(QUERY)).rejects.toBeInstanceOf(
        AddressSearchUnavailableError,
      );
    });

    it.each([
      [503, { error: 'search index not built' }],
      [401, { error: 'Unauthorized', code: 401, message: 'unknown API key' }],
      [403, { error: 'Forbidden', code: 403, message: 'disabled' }],
      [429, { error: 'Too Many Requests', message: 'rate limit exceeded' }],
      [500, {}],
    ])('HTTP %i', async (status, body) => {
      get.mockRejectedValue(refused(status, body));
      await expect(provider().search(QUERY)).rejects.toBeInstanceOf(
        AddressSearchUnavailableError,
      );
    });

    it('a request that times out', async () => {
      get.mockRejectedValue(new AxiosError('timeout', 'ECONNABORTED'));
      await expect(provider().search(QUERY)).rejects.toBeInstanceOf(
        AddressSearchUnavailableError,
      );
    });

    it('an error that is not from the request at all', async () => {
      get.mockRejectedValue(new Error('boom'));
      await expect(provider().search(QUERY)).rejects.toBeInstanceOf(
        AddressSearchUnavailableError,
      );
    });

    it.each([{}, { UZMAPS_API_KEY: '  ' }])(
      'no key configured (%j): UzMaps is not even called',
      async (env) => {
        await expect(
          provider(env as Record<string, string>).search(QUERY),
        ).rejects.toBeInstanceOf(AddressSearchUnavailableError);
        expect(get).not.toHaveBeenCalled();
      },
    );
  });

  it('after any failure, neither the log nor the error holds the key or what was typed', async () => {
    get.mockRejectedValue(refused(401, { message: 'unknown API key' }));

    const error = (await provider()
      .search(QUERY)
      .catch((err: unknown) => err)) as Error;

    const text = [...logged, error.message, JSON.stringify(error)].join('\n');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Amir');
    expect(logged.join('\n')).toContain('401');
  });

  describe('for whoever watches the bill', () => {
    const metrics = { recordUzmapsRequest: jest.fn() };
    beforeEach(() => metrics.recordUzmapsRequest.mockClear());
    const counted = () =>
      provider({ UZMAPS_API_KEY: KEY }, metrics)
        .search(QUERY)
        .catch(() => undefined);

    it.each([
      ['matches', 'success', { results: [RESULT] }],
      ['no matches', 'empty', { results: [] }],
      ['nonsense', 'failed', {}],
    ])('counts %s as %s', async (_, outcome, body) => {
      get.mockResolvedValue(answered(body));
      await counted();
      expect(metrics.recordUzmapsRequest.mock.calls).toEqual([
        ['search', outcome],
      ]);
    });

    it.each([
      [429, 'rate_limited'],
      [403, 'refused'],
      [503, 'failed'],
    ])('counts HTTP %i as %s', async (status, outcome) => {
      get.mockRejectedValue(refused(status, {}));
      await counted();
      expect(metrics.recordUzmapsRequest.mock.calls).toEqual([
        ['search', outcome],
      ]);
    });
  });
});
