// SEC-007. The lock script is exercised separately; here, the wiring around it.
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AdminLoginProtection } from './admin-login-protection.service';
import {
  PANEL_CLIENT_IP_HEADER,
  PANEL_SIGNATURE_HEADER,
  PANEL_TIMESTAMP_HEADER,
  adminClientAddress,
  verifiedPanelClientIp,
} from './admin-client-ip';
import { AdminAuthController } from './admin-auth.controller';
import { RedisKeys } from '../../redis/redis.keys';
import { RedisUnavailableError } from '../../redis/redis-backlog';
import { resolveTrustProxy } from '../../common/trust-proxy.util';

const SECRET = 'a'.repeat(40);
const PATH = '/v1/auth/admin/login';
const IP = '198.51.100.7';

function signed(over: Partial<{ ip: string; ts: string; secret: string; path: string }> = {}) {
  const ts = over.ts ?? String(Date.now());
  const ip = over.ip ?? IP;
  const signature = createHmac('sha256', over.secret ?? SECRET)
    .update(`${ts}\n${ip}\nPOST\n${over.path ?? PATH}`)
    .digest('base64url');
  return {
    method: 'POST',
    originalUrl: PATH,
    ip: '127.0.0.1',
    headers: {
      [PANEL_CLIENT_IP_HEADER]: ip,
      [PANEL_TIMESTAMP_HEADER]: ts,
      [PANEL_SIGNATURE_HEADER]: signature,
    },
  } as never;
}

describe('the panel-signed client address', () => {
  it('is believed when correctly signed', () => {
    expect(verifiedPanelClientIp(signed(), SECRET)).toBe(IP);
  });
  it('is ignored with the wrong secret', () => {
    expect(verifiedPanelClientIp(signed({ secret: 'b'.repeat(40) }), SECRET)).toBeNull();
  });
  it('is ignored when old, so a captured header cannot be replayed later', () => {
    expect(
      verifiedPanelClientIp(signed({ ts: String(Date.now() - 120_000) }), SECRET),
    ).toBeNull();
  });
  it('is ignored when signed for another route', () => {
    expect(verifiedPanelClientIp(signed({ path: '/other' }), SECRET)).toBeNull();
  });
  it('is ignored when the address was swapped after signing', () => {
    const req = signed() as any;
    req.headers[PANEL_CLIENT_IP_HEADER] = '203.0.113.5';
    expect(verifiedPanelClientIp(req, SECRET)).toBeNull();
  });
  it('is ignored with no secret configured', () => {
    expect(verifiedPanelClientIp(signed(), undefined)).toBeNull();
  });
});

describe('adminClientAddress', () => {
  const original = process.env.ADMIN_PROXY_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_PROXY_SECRET;
    else process.env.ADMIN_PROXY_SECRET = original;
  });
  const direct = { ip: '203.0.113.5', headers: {}, method: 'POST', originalUrl: PATH } as never;

  it('without the secret, addresses do not identify anyone', () => {
    delete process.env.ADMIN_PROXY_SECRET;
    expect(adminClientAddress(direct)).toEqual({ ip: '203.0.113.5', distinct: false });
  });
  it('with the secret, a signed address is used', () => {
    process.env.ADMIN_PROXY_SECRET = SECRET;
    expect(adminClientAddress(signed())).toEqual({
      ip: IP,
      distinct: true,
      proof: expect.any(String),
    });
  });
  it('with the secret, an unsigned caller is counted by its own address', () => {
    process.env.ADMIN_PROXY_SECRET = SECRET;
    expect(adminClientAddress(direct)).toEqual({ ip: '203.0.113.5', distinct: true });
  });
});

describe('trust proxy', () => {
  async function ipSeen(trust: string, xff: string) {
    const app = express();
    app.set('trust proxy', trust);
    app.get('/', (req, res) => res.send(req.ip));
    const { text } = await request(app).get('/').set('X-Forwarded-For', xff);
    return text;
  }

  it('behind local Nginx, a spoofed X-Forwarded-For entry cannot replace the real one', async () => {
    // Nginx appends the real client last; what the client sent sits to its left.
    expect(await ipSeen('loopback', '1.2.3.4, 198.51.100.7')).toBe('198.51.100.7');
    expect(await ipSeen('loopback', '9.9.9.9, 198.51.100.7')).toBe('198.51.100.7');
  });
  it('a caller not on the trusted list cannot pick its address at all', async () => {
    // supertest connects from loopback, which this list does not trust.
    expect(await ipSeen('192.0.2.1', '1.2.3.4')).toMatch(/127\.0\.0\.1/);
  });
  it('defaults to loopback, and refuses blanket trust', () => {
    expect(resolveTrustProxy(undefined)).toBe('loopback');
    expect(resolveTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(() => resolveTrustProxy('true')).toThrow();
    expect(() => resolveTrustProxy('1')).toThrow();
  });
});

describe('AdminLoginProtection', () => {
  function build() {
    const redis = {
      evalScript: jest.fn(async () => ['', 0]),
      del: jest.fn(async () => 1),
      setEx: jest.fn(async () => 'OK'),
      setNxEx: jest.fn(async () => true),
    };
    const protection = new AdminLoginProtection(redis as never);
    jest.spyOn((protection as any).logger, 'warn').mockImplementation();
    return { protection, redis };
  }
  const client = { ip: IP, distinct: true };

  it('counts case variants of an email as one account', async () => {
    const { protection, redis } = build();
    await protection.beginAttempt('Op@Mator.uz', client);
    await protection.beginAttempt(' op@mator.uz ', client);
    const [a, b] = redis.evalScript.mock.calls as any[];
    expect(a[1]).toEqual(b[1]);
  });

  it('keeps no email or address in its keys', async () => {
    const { protection, redis } = build();
    await protection.beginAttempt('op@mator.uz', client);
    const keys = (redis.evalScript.mock.calls[0] as any[])[1].join(' ');
    expect(keys).not.toContain('op@mator.uz');
    expect(keys).not.toContain(IP);
  });

  it('answers a lock with 429 and how long', async () => {
    const { protection, redis } = build();
    redis.evalScript.mockResolvedValue(['account', 30]);
    await expect(protection.beginAttempt('op@mator.uz', client)).rejects.toMatchObject({
      status: 429,
      response: { code: 'ADMIN_LOGIN_LOCKED', details: { retry_after_seconds: 30 } },
    });
  });

  it('refuses sign-in when the counters are unreachable', async () => {
    const { protection, redis } = build();
    redis.evalScript.mockRejectedValue(new RedisUnavailableError('down'));
    await expect(protection.beginAttempt('op@mator.uz', client)).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });

  it('success clears the account and remembers the address, not the address counter', async () => {
    const { protection, redis } = build();
    await protection.recordSuccess('op@mator.uz', client);
    const deleted = redis.del.mock.calls.map((c: any[]) => c[0] as string);
    expect(deleted).toHaveLength(4);
    expect(deleted.some((k) => k.startsWith('rate:admin:login:ip:'))).toBe(false);
    // The address counter gives back this one attempt and no more.
    const [, keys] = redis.evalScript.mock.calls[0] as any[];
    expect(keys[0]).toMatch(/^rate:admin:login:ip:/);
    expect((redis.setEx.mock.calls[0] as any[])[0]).toMatch(/^admin:login:trusted:/);
  });

  it('remembers no address when addresses do not identify anyone', async () => {
    const { protection, redis } = build();
    await protection.recordSuccess('op@mator.uz', { ip: IP, distinct: false });
    expect(redis.setEx).not.toHaveBeenCalled();
  });

  it('a Redis hiccup after a correct password does not cost the login', async () => {
    const { protection, redis } = build();
    redis.del.mockRejectedValue(new RedisUnavailableError('down'));
    await expect(protection.recordSuccess('op@mator.uz', client)).resolves.toBeUndefined();
  });

  describe('a panel signature used twice', () => {
    const original = process.env.ADMIN_PROXY_SECRET;
    beforeEach(() => {
      process.env.ADMIN_PROXY_SECRET = SECRET;
    });
    afterEach(() => {
      if (original === undefined) delete process.env.ADMIN_PROXY_SECRET;
      else process.env.ADMIN_PROXY_SECRET = original;
    });

    it('is believed the first time', async () => {
      const { protection } = build();
      expect(await protection.resolveClient(signed())).toMatchObject({ ip: IP, distinct: true });
    });

    it('falls back to the caller\'s own address when replayed', async () => {
      const { protection, redis } = build();
      redis.setNxEx.mockResolvedValue(false as never);
      expect(await protection.resolveClient(signed())).toEqual({ ip: '127.0.0.1', distinct: true });
    });

    it('refuses rather than guesses when it cannot be checked', async () => {
      const { protection, redis } = build();
      redis.setNxEx.mockRejectedValue(new RedisUnavailableError('down'));
      await expect(protection.resolveClient(signed())).rejects.toBeInstanceOf(RedisUnavailableError);
    });

    it('an unsigned caller costs no Redis call', async () => {
      const { protection, redis } = build();
      await protection.resolveClient({ ip: '203.0.113.5', headers: {}, method: 'POST', originalUrl: PATH } as never);
      expect(redis.setNxEx).not.toHaveBeenCalled();
    });
  });

  it('uses the documented keys', () => {
    expect(RedisKeys.adminLoginTrusted('x')).toBe('admin:login:trusted:x');
  });
});

describe('AdminAuthController.login', () => {
  const dto = { email: 'op@mator.uz', password: 'pw', deviceName: 'd' } as never;
  const req = { ip: IP, headers: {}, get: () => 'ua', method: 'POST', originalUrl: PATH } as never;

  function build(login: jest.Mock) {
    const protection = {
      resolveClient: jest.fn().mockResolvedValue({ ip: IP, distinct: true }),
      beginAttempt: jest.fn(),
      recordSuccess: jest.fn(),
    };
    const controller = new AdminAuthController({ login } as never, protection as never);
    return { controller, protection };
  }

  it.each(['OPERATOR', 'MANAGER', 'SUPER_ADMIN'])('a valid %s signs in as before', async (role) => {
    const session = { accessToken: 'a', role };
    const { controller, protection } = build(jest.fn().mockResolvedValue(session));
    await expect(controller.login(dto, req)).resolves.toBe(session);
    expect(protection.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it('a locked attempt never reaches the password check', async () => {
    const login = jest.fn();
    const { controller, protection } = build(login);
    protection.beginAttempt.mockRejectedValue(Object.assign(new Error('x'), { status: 429 }));
    await expect(controller.login(dto, req)).rejects.toMatchObject({ status: 429 });
    expect(login).not.toHaveBeenCalled();
  });

  it('a wrong password records no success', async () => {
    const { controller, protection } = build(jest.fn().mockRejectedValue(new Error('401')));
    await expect(controller.login(dto, req)).rejects.toThrow('401');
    expect(protection.recordSuccess).not.toHaveBeenCalled();
  });
});
