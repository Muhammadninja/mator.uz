// Unit tests for the Basic Auth gate in front of the Swagger UI.
//
// /docs publishes the complete route and DTO map, so the failure mode that
// matters is "accidentally public". These tests pin: fail-closed on missing
// credentials, rejection of wrong/absent/malformed headers, the challenge and
// no-store headers, and that a valid credential passes through.

import { Logger } from '@nestjs/common';
import { BasicAuthThrottle } from './basic-auth-throttle';
import type { Request, Response } from 'express';
import {
  createSwaggerAuthMiddleware,
  resolveSwaggerCredentials,
} from './swagger-auth.middleware';

const CREDS = { user: 'docsuser', password: 's3cret:with:colons' };

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as unknown as Response & typeof res;
}

function makeReq(authorization?: string) {
  return {
    headers: authorization ? { authorization } : {},
    ip: '203.0.113.5',
  } as Request;
}

const basic = (user: string, password: string) =>
  'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

/** Silent logger — these tests assert behaviour, not log output. */
function quietLogger() {
  const logger = new Logger('test');
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return logger;
}

/** A limiter that never trips: these tests are about the credentials. */
const throttle = () =>
  new BasicAuthThrottle(
    {
      consume: () => Promise.resolve({ allowed: true, retryAfter: 0 }),
      check: () => Promise.resolve({ allowed: true, retryAfter: 0 }),
    } as never,
    'swagger',
  );

/** The limiter answers asynchronously: let it finish before asserting. */
const settled = async (_: unknown): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe('createSwaggerAuthMiddleware', () => {
  it('passes a request with the correct credentials', async () => {
    const next = jest.fn();
    const res = makeRes();
    await settled(createSwaggerAuthMiddleware(CREDS, quietLogger(), throttle())(
      makeReq(basic(CREDS.user, CREDS.password)),
      res,
      next,
    ));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0); // untouched
  });

  it('keeps a password containing colons intact', async () => {
    // Splitting on every colon would corrupt this password and lock the user out.
    const next = jest.fn();
    await settled(createSwaggerAuthMiddleware(CREDS, quietLogger(), throttle())(
      makeReq(basic('docsuser', 's3cret:with:colons')),
      makeRes(),
      next,
    ));
    expect(next).toHaveBeenCalled();
  });

  it.each([
    ['no Authorization header', undefined],
    ['a Bearer token', 'Bearer some.jwt.token'],
    [
      'a malformed Basic value',
      'Basic ' + Buffer.from('no-separator').toString('base64'),
    ],
    ['an empty Basic value', 'Basic '],
    ['the wrong password', basic('docsuser', 'wrong')],
    ['the wrong username', basic('someone', 's3cret:with:colons')],
  ])('rejects %s with 401', async (_label, header) => {
    const next = jest.fn();
    const res = makeRes();
    await settled(createSwaggerAuthMiddleware(CREDS, quietLogger(), throttle())(
      makeReq(header),
      res,
      next,
    ));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    // A browser needs the challenge to prompt for credentials.
    expect(res.headers['WWW-Authenticate']).toContain('Basic');
    // Docs must never sit in an intermediary cache.
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('FAILS CLOSED when credentials are not configured', async () => {
    // The critical case: a misconfiguration must deny, never publish the API map.
    for (const creds of [
      { user: '', password: '' },
      { user: 'docsuser', password: '' },
      { user: '', password: 's3cret' },
    ]) {
      const next = jest.fn();
      const res = makeRes();
      await settled(createSwaggerAuthMiddleware(creds, quietLogger(), throttle())(
        makeReq(basic('docsuser', 's3cret')),
        res,
        next,
      ));
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    }
  });

  it('never reveals which half of the credential was wrong', async () => {
    const answers = [
      basic('wrong-user', CREDS.password),
      basic(CREDS.user, 'wrong-pass'),
    ].map(async (header) => {
      const res = makeRes();
      await settled(createSwaggerAuthMiddleware(CREDS, quietLogger(), throttle())(
        makeReq(header),
        res,
        jest.fn(),
      ));
      return { status: res.statusCode, body: res.body };
    });
    const bodies = await Promise.all(answers);
    expect(bodies[0]).toEqual(bodies[1]);
  });
});

describe('resolveSwaggerCredentials', () => {
  it('reads and trims the username', async () => {
    expect(
      resolveSwaggerCredentials({
        SWAGGER_USERNAME: '  docsuser  ',
        SWAGGER_PASSWORD: 's3cret',
      }),
    ).toEqual({ user: 'docsuser', password: 's3cret' });
  });

  it('preserves the password verbatim (whitespace may be significant)', async () => {
    expect(
      resolveSwaggerCredentials({
        SWAGGER_USERNAME: 'u',
        SWAGGER_PASSWORD: ' pad ',
      }).password,
    ).toBe(' pad ');
  });

  it('yields empty strings when unset, which the middleware treats as fail-closed', async () => {
    expect(resolveSwaggerCredentials({})).toEqual({
      user: '',
      password: '',
    });
  });
});
