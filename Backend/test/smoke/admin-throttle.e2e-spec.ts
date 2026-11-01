// The global throttler as an operator meets it: everyone arrives from the panel
// server's one address, so a limit counted per address would be shared by the team.
// A real ThrottlerGuard over a small controller, with tokens signed the way
// AdminTokenService signs them.

import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
} from '@nestjs/throttler';
import { createHmac } from 'crypto';
import request from 'supertest';
import {
  THROTTLERS,
  verifiedAdminId,
} from '../../src/admin/auth/admin-throttle';

// Spending a budget takes over a hundred sequential requests, which the default 5s
// does not always cover while other suites run alongside.
jest.setTimeout(30_000);

const SECRET = 'throttle-test-secret-'.repeat(3);

function token(
  sub: string,
  over: Record<string, unknown> = {},
  secret = SECRET,
) {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub,
    type: 'admin',
    iss: 'mator-admin',
    aud: 'mator-admin-panel',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...over,
  });
  const sig = createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `Bearer ${head}.${body}.${sig}`;
}

@Controller()
class ProbeController {
  @Get('queue')
  queue() {
    return { ok: true };
  }

  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login() {
    return { ok: true };
  }

  @Post('webhook')
  @SkipThrottle()
  webhook() {
    return { ok: true };
  }
}

describe('global throttling of admin traffic', () => {
  let app: INestApplication;
  const previousSecret = process.env.ADMIN_JWT_SECRET;

  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = SECRET;
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(THROTTLERS)],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env.ADMIN_JWT_SECRET = previousSecret;
  });

  const hit = (auth?: string) => {
    const req = request(app.getHttpServer()).get('/queue');
    return auth ? req.set('Authorization', auth) : req;
  };
  const exhaust = async (auth: string) => {
    for (let i = 0; i < 100; i += 1) await hit(auth).expect(200);
  };

  it('one operator using up their budget does not touch another', async () => {
    await exhaust(token('operator-with-many-tabs'));

    await hit(token('operator-with-many-tabs')).expect(429);
    await hit(token('someone-else')).expect(200);
  });

  it('a forged token does not earn a fresh budget', async () => {
    for (let i = 0; i < 100; i += 1) {
      await hit(token(`forged-${i}`, {}, 'not-the-secret')).expect(200);
    }
    await hit(token('forged-another', {}, 'not-the-secret')).expect(429);
  });

  it('an admin spending their budget does not use up the address for others', async () => {
    await exhaust(token('busy-admin'));

    await hit().expect(200);
  });

  it('login stays limited per address at its own tighter limit', async () => {
    const login = () => request(app.getHttpServer()).post('/login');
    for (let i = 0; i < 5; i += 1) await login().expect(201);
    await login().expect(429);
  });

  it('a route that skips throttling still skips it, with or without a token', async () => {
    const webhook = () => request(app.getHttpServer()).post('/webhook');
    for (let i = 0; i < 150; i += 1) await webhook().expect(201);
    await webhook().set('Authorization', token('a')).expect(201);
  });
});

describe('verifiedAdminId', () => {
  const now = Date.now();

  it('returns the subject of a valid admin token', () => {
    expect(verifiedAdminId(token('adm_1'), SECRET, now)).toBe('adm_1');
  });

  it.each([
    ['no header', undefined],
    ['not a bearer', 'Basic abc'],
    ['garbage', 'Bearer not.a.jwt'],
    ['wrong signature', token('a', {}, 'other')],
    ['an expired token', token('a', { exp: Math.floor(now / 1000) - 1 })],
    ['a user token', token('a', { type: 'user' })],
    ['another issuer', token('a', { iss: 'mator-app' })],
    ['another audience', token('a', { aud: 'mator-app' })],
  ])('refuses %s', (_label, header) => {
    expect(verifiedAdminId(header, SECRET, now)).toBeNull();
  });

  it('counts nobody as an admin when no secret is configured', () => {
    expect(verifiedAdminId(token('a'), undefined, now)).toBeNull();
  });
});
