import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  type ArgumentsHost,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import {
  OTHER_ROUTE,
  ServerErrorLog,
  describeError,
  routeTemplate,
  serverErrors,
} from './server-errors';

/** Drive the real global filter with one exception on one request. */
function answer(exception: unknown, req: Record<string, unknown>) {
  const json = jest.fn();
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({
        headersSent: false,
        setHeader: jest.fn(),
        status: jest.fn(() => ({ json })),
      }),
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  const filter = new HttpExceptionFilter();
  jest
    .spyOn(
      (filter as unknown as { logger: { error: () => void } }).logger,
      'error',
    )
    .mockImplementation(() => undefined);
  filter.catch(exception, host);
}

describe('HttpExceptionFilter → serverErrors', () => {
  beforeEach(() => serverErrors.reset());

  it('counts every 5xx it answers, by route template, status and last error', () => {
    const req = {
      method: 'post',
      url: '/v1/orders/ord_1/cancel',
      baseUrl: '',
      route: { path: '/v1/orders/:id/cancel' },
      requestId: '3AA7FC',
    };
    answer(new TypeError('x is undefined'), req);
    answer(new ServiceUnavailableException('down'), req);

    const snap = serverErrors.snapshot();
    expect(snap.total).toBe(2);
    expect([...snap.byRoute]).toEqual([['POST /v1/orders/:id/cancel', 2]]);
    expect([...snap.byStatus].sort()).toEqual([
      [500, 1],
      [503, 1],
    ]);
    expect(serverErrors.latestSince(0)).toMatchObject({
      status: 503,
      message: 'ServiceUnavailableException: down',
      requestId: '3AA7FC',
    });
  });

  it('does not count what the client got wrong (4xx)', () => {
    answer(new BadRequestException('bad'), { method: 'GET', url: '/x' });
    answer(new NotFoundException(), { method: 'GET', url: '/y' });

    expect(serverErrors.snapshot().total).toBe(0);
  });
});

describe('ServerErrorLog', () => {
  it('keeps routes bounded, folding the overflow into `other`', () => {
    const log = new ServerErrorLog();
    for (let i = 0; i < 250; i += 1) {
      log.record({ at: i, route: `GET /r${i}`, status: 500, message: 'e' });
    }
    const { byRoute, total } = log.snapshot();

    expect(total).toBe(250);
    expect(byRoute.size).toBe(201);
    expect(byRoute.get(OTHER_ROUTE)).toBe(50);
  });

  it('gives the latest error only when it is recent enough', () => {
    const log = new ServerErrorLog();
    log.record({
      at: 1_000,
      route: 'GET /a',
      status: 500,
      message: ' a\n  b ',
    });

    expect(log.latestSince(500)?.message).toBe('a b');
    expect(log.latestSince(2_000)).toBeUndefined();
  });
});

describe('routeTemplate / describeError', () => {
  it('names the matched template, never the raw URL', () => {
    expect(
      routeTemplate({
        method: 'get',
        baseUrl: '/v1',
        route: { path: '/parts/:id' },
      }),
    ).toBe('GET /v1/parts/:id');
    expect(routeTemplate({ method: 'GET' })).toBe('GET (unmatched)');
  });

  it('prefixes the error class', () => {
    expect(describeError(new RangeError('too big'))).toBe(
      'RangeError: too big',
    );
    expect(describeError('plain')).toBe('plain');
  });
});
