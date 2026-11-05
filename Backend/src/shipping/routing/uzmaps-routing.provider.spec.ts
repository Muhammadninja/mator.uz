/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- reads the arguments of a jest spy, which are untyped */
// The UzMaps adapter, against the contract at https://docs.uzmaps.uz/http-routing/.
// axios is stubbed, so nothing here reaches the network.

import { Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosResponse } from 'axios';
import {
  RouteNotFoundError,
  RoutingUnavailableError,
} from './routing-provider';
import {
  fastestRouteDistance,
  UzmapsRoutingProvider,
} from './uzmaps-routing.provider';

const KEY = 'secret-uzmaps-key';
const ORIGIN = { lat: 41.2995, lng: 69.2401 };
const DESTINATION = { lat: 41.3131, lng: 69.287 };

const provider = (env: Record<string, string> = { UZMAPS_API_KEY: KEY }) =>
  new UzmapsRoutingProvider({ get: (key: string) => env[key] } as never);

const answered = (data: unknown) => ({ data }) as AxiosResponse;

/** A failed request as axios reports it, carrying the headers as axios does. */
const refused = (status: number, data: unknown) =>
  new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    { headers: { 'X-API-Key': KEY } } as never,
    undefined,
    { status, data } as AxiosResponse,
  );

describe('UzmapsRoutingProvider', () => {
  let post: jest.SpyInstance;
  let logged: string[];

  beforeEach(() => {
    post = jest.spyOn(axios, 'post');
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

  const route = () => provider().routeDistanceMeters(ORIGIN, DESTINATION);

  it('asks for the documented route, with coordinates as [longitude, latitude]', async () => {
    post.mockResolvedValue(
      answered({ routes: [{ distance: 6094, duration: 419 }] }),
    );

    await expect(route()).resolves.toBe(6094);

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, options] = post.mock.calls[0];
    expect(url).toBe('https://uzmaps.uz/api/route');
    expect(body).toEqual({
      mode: 'car',
      alternatives: 3,
      shortest: false,
      points: [
        [69.2401, 41.2995],
        [69.287, 41.3131],
      ],
    });
    expect(options.headers).toEqual({ 'X-API-Key': KEY });
    // Set, and below UzMaps' own 25 s, or a slow engine would hold a checkout open.
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThan(25_000);
  });

  it('prices the fastest route, not the recommended one and not the shortest', async () => {
    post.mockResolvedValue(
      answered({
        routes: [
          { id: 'route-0', recommended: true, distance: 6000, duration: 500 },
          { id: 'route-1', distance: 7500, duration: 400 },
          { id: 'route-2', distance: 5000, duration: 700 },
        ],
      }),
    );

    await expect(route()).resolves.toBe(7500);
  });

  it('answers with a distance alone: duration and geometry stop here', async () => {
    post.mockResolvedValue(
      answered({
        routes: [
          {
            distance: 6094,
            duration: 419,
            geometry: [[69.24, 41.29]],
            legs: [],
          },
        ],
      }),
    );

    await expect(route()).resolves.toStrictEqual(6094);
  });

  describe('when the answer is no route', () => {
    it.each([
      ['an empty list', { routes: [] }],
      ['only a zero distance', { routes: [{ distance: 0, duration: 10 }] }],
      ['only unusable routes', { routes: [null, { distance: 'far' }] }],
    ])('%s', async (_, body) => {
      post.mockResolvedValue(answered(body));
      await expect(route()).rejects.toBeInstanceOf(RouteNotFoundError);
    });

    it.each(['no route found', 'routing: No suitable edges near location'])(
      '502 %p',
      async (error) => {
        post.mockRejectedValue(refused(502, { error }));
        await expect(route()).rejects.toBeInstanceOf(RouteNotFoundError);
      },
    );
  });

  describe('when no answer could be had', () => {
    it.each([
      ['no routes field', {}],
      ['routes that are not a list', { routes: 'none' }],
      ['an empty body', ''],
      ['null', null],
    ])('a 200 with %s is not an answer', async (_, body) => {
      post.mockResolvedValue(answered(body));
      await expect(route()).rejects.toBeInstanceOf(RoutingUnavailableError);
    });

    it.each([
      [502, { error: 'routing engine unavailable: connection refused' }],
      [502, { error: 'routing: HTTP 500' }],
      [502, 'Bad Gateway'],
      [500, {}],
      [503, { error: 'routing engine not configured' }],
      [400, { error: 'at least two points required' }],
      [401, { error: 'Unauthorized', code: 401, message: 'unknown API key' }],
      [
        403,
        { error: 'Forbidden', code: 403, message: 'this API key is disabled' },
      ],
      [429, { error: 'Too Many Requests', message: 'rate limit exceeded' }],
    ])('HTTP %i %j', async (status, body) => {
      post.mockRejectedValue(refused(status, body));
      await expect(route()).rejects.toBeInstanceOf(RoutingUnavailableError);
    });

    it.each(['ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'])(
      'a request ending in %s',
      async (code) => {
        post.mockRejectedValue(new AxiosError('failed', code));
        await expect(route()).rejects.toBeInstanceOf(RoutingUnavailableError);
      },
    );

    it('a response too large to read', async () => {
      post.mockRejectedValue(
        new AxiosError(
          'maxContentLength exceeded',
          AxiosError.ERR_BAD_RESPONSE,
        ),
      );
      await expect(route()).rejects.toBeInstanceOf(RoutingUnavailableError);
    });

    it('an error that is not from the request at all', async () => {
      post.mockRejectedValue(new Error('boom'));
      await expect(route()).rejects.toBeInstanceOf(RoutingUnavailableError);
    });

    it.each([{}, { UZMAPS_API_KEY: '' }, { UZMAPS_API_KEY: '   ' }])(
      'no key configured (%j): UzMaps is not even called',
      async (env) => {
        await expect(
          provider(env as Record<string, string>).routeDistanceMeters(
            ORIGIN,
            DESTINATION,
          ),
        ).rejects.toBeInstanceOf(RoutingUnavailableError);
        expect(post).not.toHaveBeenCalled();
      },
    );
  });

  describe('keeps its secrets', () => {
    it.each([
      [401, { error: 'Unauthorized', message: 'unknown API key' }],
      [429, { error: 'Too Many Requests' }],
      [500, {}],
    ])(
      'after an HTTP %i, neither the log nor the error holds the key or a location',
      async (status, body) => {
        post.mockRejectedValue(refused(status, body));

        const error = (await route().catch((err: unknown) => err)) as Error;

        const text = [...logged, error.message, JSON.stringify(error)].join(
          '\n',
        );
        expect(text).not.toContain(KEY);
        expect(text).not.toContain('69.28');
        expect(text).not.toContain('41.31');
        expect(logged.join('\n')).toContain(String(status));
      },
    );

    it('reports a rejected key or an exhausted quota louder than a passing failure', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      post.mockRejectedValue(refused(500, {}));
      await route().catch(() => undefined);
      expect(error).not.toHaveBeenCalled();

      post.mockRejectedValue(refused(429, { message: 'quota exceeded' }));
      await route().catch(() => undefined);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('quota exceeded'),
      );
    });
  });
});

describe('UzmapsRoutingProvider, for whoever watches the bill', () => {
  const metrics = { recordUzmapsRequest: jest.fn() };
  const counted = () =>
    new UzmapsRoutingProvider(
      { get: () => KEY } as never,
      metrics as never,
    ).routeDistanceMeters(ORIGIN, DESTINATION);

  beforeEach(() => metrics.recordUzmapsRequest.mockClear());
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['a route', 'success', () => answered({ routes: [{ distance: 1, duration: 1 }] })],
    ['no route', 'empty', () => answered({ routes: [] })],
  ])('counts %s as %s', async (_, outcome, answer) => {
    jest.spyOn(axios, 'post').mockResolvedValue(answer());
    await counted().catch(() => undefined);
    expect(metrics.recordUzmapsRequest).toHaveBeenCalledWith('routing', outcome);
  });

  it.each([
    [429, 'rate_limited'],
    [401, 'refused'],
    [403, 'refused'],
    [500, 'failed'],
  ])('counts HTTP %i as %s', async (status, outcome) => {
    jest.spyOn(axios, 'post').mockRejectedValue(refused(status, {}));
    await counted().catch(() => undefined);
    expect(metrics.recordUzmapsRequest).toHaveBeenCalledWith('routing', outcome);
  });

  it('counts each request once', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(refused(429, {}));
    await counted().catch(() => undefined);
    expect(metrics.recordUzmapsRequest).toHaveBeenCalledTimes(1);
  });
});

describe('fastestRouteDistance', () => {
  it('skips what cannot be compared or priced, whichever field is wrong', () => {
    expect(
      fastestRouteDistance([
        { distance: 1000, duration: 0 },
        { distance: 1000, duration: -5 },
        { distance: 1000, duration: NaN },
        { distance: 1000, duration: '10' },
        { distance: 1000 },
        { distance: NaN, duration: 1 },
        { distance: Infinity, duration: 1 },
        { distance: -1, duration: 1 },
        { distance: 0, duration: 1 },
        { duration: 1 },
        null,
        undefined,
        'route',
        { distance: 4200, duration: 900 },
      ]),
    ).toBe(4200);
  });

  it('on a tie keeps the earlier route, which UzMaps recommends', () => {
    expect(
      fastestRouteDistance([
        { distance: 3000, duration: 300 },
        { distance: 2000, duration: 300 },
      ]),
    ).toBe(3000);
  });

  it('is null when nothing is usable', () => {
    expect(fastestRouteDistance([])).toBeNull();
    expect(fastestRouteDistance([{ distance: 0, duration: 0 }])).toBeNull();
  });
});
