import { ConfigService } from '@nestjs/config';
import { ServerErrorLog } from '../../common/server-errors';
import { AlertSeverity } from '../alerting.types';
import { HttpErrorsRule, topDeltas } from './http-errors.rule';

function configWith(env: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const MIN = 60_000;

function fail(
  log: ServerErrorLog,
  at: number,
  route = 'POST /v1/orders',
  status = 500,
) {
  log.record({
    at,
    route,
    status,
    message: 'TypeError: x is undefined',
    requestId: `req_${at}`,
  });
}

describe('HttpErrorsRule', () => {
  let now: number;
  beforeEach(() => {
    now = Date.now();
  });

  it('fires on the first 5xx, from the very first evaluation after boot', async () => {
    const log = new ServerErrorLog();
    const rule = new HttpErrorsRule(configWith(), log);
    fail(log, now + 1_000);

    const { firing } = await rule.evaluate(now + MIN);

    expect(firing).toHaveLength(1);
    expect(firing[0]).toMatchObject({
      rule: 'http_5xx',
      severity: AlertSeverity.ERROR,
      labels: {},
      title: 'HTTP 5xx Errors',
      values: {
        errors_5min: 1,
        threshold: 1,
        statuses: '500 ×1',
        routes: 'POST /v1/orders ×1',
        last_error: 'TypeError: x is undefined',
        last_route: 'POST /v1/orders',
        last_request_id: `req_${now + 1_000}`,
      },
    });
  });

  it('stays quiet with no errors, and resolves once a window passes without any', async () => {
    const log = new ServerErrorLog();
    const rule = new HttpErrorsRule(configWith(), log);
    expect((await rule.evaluate(now + MIN)).firing).toHaveLength(0);

    fail(log, now + MIN);
    expect((await rule.evaluate(now + 2 * MIN)).firing).toHaveLength(1);

    // Errors stop; within the 5 min window they still count, after it they do not.
    for (let m = 3; m <= 7; m += 1) await rule.evaluate(now + m * MIN);
    expect((await rule.evaluate(now + 8 * MIN)).firing).toHaveLength(0);
  });

  it('honours the thresholds and turns CRITICAL on a flood', async () => {
    const log = new ServerErrorLog();
    const rule = new HttpErrorsRule(
      configWith({
        HTTP_5XX_ALERT_THRESHOLD: '3',
        HTTP_5XX_CRITICAL_THRESHOLD: '10',
      }),
      log,
    );
    fail(log, now);
    fail(log, now);
    expect((await rule.evaluate(now + MIN)).firing).toHaveLength(0);

    for (let i = 0; i < 8; i += 1) fail(log, now + MIN, 'GET /v1/cart', 502);
    const { firing } = await rule.evaluate(now + 2 * MIN);

    expect(firing[0].severity).toBe(AlertSeverity.CRITICAL);
    expect(firing[0].values).toMatchObject({
      errors_5min: 10,
      statuses: '502 ×8, 500 ×2',
      routes: 'GET /v1/cart ×8, POST /v1/orders ×2',
    });
  });
});

describe('topDeltas', () => {
  it('shows the largest increases first and counts the rest', () => {
    const current = new Map([
      ['a', 5],
      ['b', 9],
      ['c', 2],
      ['d', 1],
      ['e', 3],
    ]);
    const baseline = new Map([
      ['a', 1],
      ['e', 3],
    ]);

    expect(topDeltas(current, baseline)).toBe('b ×9, a ×4, c ×2 (+1 more)');
  });
});
