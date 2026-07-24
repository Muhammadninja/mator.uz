import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from '../../src/auth/auth.controller';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy';
import { JwtPayload } from '../../src/auth/interfaces/jwt-payload.interface';
import { OtpService } from '../../src/auth/phone/otp.service';
import { FixedWindowRateLimiter } from '../../src/redis/rate-limiter.service';
import { PhoneChangeService } from '../../src/user/phone-change.service';
import { PhoneAuthService } from '../../src/auth/phone/phone-auth.service';
import { MyIdService } from '../../src/auth/myid/myid.service';
import { AuthService } from '../../src/auth/auth.service';
import { SocialIdentityService } from '../../src/auth/social/social-identity.service';
import { TokenService } from '../../src/auth/tokens/token.service';
import { JwtKeyService } from '../../src/auth/tokens/jwt-key.service';
import { hashPassword } from '../../src/auth/password.util';
import { RedisKeys } from '../../src/redis/redis.keys';
import { createPrismaMock, fakeConfig, fakeRedis, buildAppUser, PrismaMock } from '../utils/harness';

/** Real token service (ephemeral RS256 keypair) for end-to-end token integration. */
function realTokens(prisma: PrismaMock, redis: any = fakeRedis()) {
  const keys = new JwtKeyService(fakeConfig());
  const tokens = new TokenService(prisma, new JwtService({}), keys, fakeConfig(), redis);
  prisma.refreshToken.create.mockResolvedValue({ id: 'rt_row' });
  return { tokens, keys, redis };
}

describe('Auth smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  describe('Phone OTP', () => {
    it('issues, then verifies the exact code that was sent', async () => {
      const sms = { sendSms: jest.fn().mockResolvedValue(undefined) };
      // No AUTH_DEV_MODE → production path: SMS is sent, no dev code returned.
      // OTP now lives in Redis; the hourly ceiling runs through FixedWindowRateLimiter.
      const redis = fakeRedis();
      const otp = new OtpService(
        redis as any,
        sms as any,
        fakeConfig(),
        new FixedWindowRateLimiter(redis as any),
      );
      const phone = '+998901112233';

      const issued = await otp.request(phone);
      expect(issued.otpLength).toBe(6);
      expect(sms.sendSms).toHaveBeenCalledTimes(1);

      const code = /(\d{6})/.exec(sms.sendSms.mock.calls[0][1])![1];
      // The exact code verifies and consumes the record (key removed from Redis).
      await expect(otp.verify(issued.requestId, phone, code)).resolves.toBeUndefined();
      expect(redis.store.has(RedisKeys.otp(phone))).toBe(false);
    });

    it('rejects an incorrect code and counts the attempt', async () => {
      const sms = { sendSms: jest.fn().mockResolvedValue(undefined) };
      const redis = fakeRedis();
      const otp = new OtpService(
        redis as any,
        sms as any,
        fakeConfig(),
        new FixedWindowRateLimiter(redis as any),
      );
      const phone = '+998901112233';

      const issued = await otp.request(phone);
      await expect(otp.verify(issued.requestId, phone, '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // A wrong guess bumps the stored attempt counter in place (record survives).
      const rec = redis.store.get(RedisKeys.otp(phone)) as { attempts: number };
      expect(rec.attempts).toBe(1);
    });

    it('verifyOtp creates a new phone account and issues a session', async () => {
      const otp = { verify: jest.fn().mockResolvedValue(undefined) };
      const tokens = {
        issueSession: jest.fn().mockResolvedValue({
          accessToken: 'a.b.c',
          accessTokenExpiresAt: new Date(),
          refreshToken: 'rt_x',
          refreshTokenExpiresAt: new Date(),
          tokenType: 'Bearer',
        }),
      };
      const svc = new PhoneAuthService(prisma, otp as any, tokens as any);
      prisma.appUser.findUnique.mockResolvedValue(null);
      prisma.appUser.create.mockResolvedValue(
        buildAppUser({ phoneE164: '+998901112233', phoneVerified: true }),
      );

      const res = await svc.verifyOtp({
        request_id: 'otp_1',
        phone_e164: '+998901112233',
        otp_code: '123456',
      } as any);

      expect(otp.verify).toHaveBeenCalled();
      expect(prisma.appUser.create).toHaveBeenCalled();
      expect(res.tokens.access_token).toBe('a.b.c');
      // MyID is no longer part of onboarding: phone login always lands on the
      // garage and never exposes requires_myid_verification.
      expect(res).not.toHaveProperty('requires_myid_verification');
      expect(res.next_screen).toBe('GarageListScreen');
    });
  });

  describe('MyID', () => {
    it('initiate builds a PKCE authorize URL and persists the session', async () => {
      const svc = new MyIdService(prisma, fakeConfig());
      prisma.myIdSession.create.mockResolvedValue({});
      prisma.appUser.update.mockResolvedValue({});

      const res = await svc.initiate('usr_1', { redirect_uri: 'mator://myid/cb' } as any);
      expect(res.session_id).toMatch(/^myid_sess_/);
      expect(res.authorize_url).toContain('code_challenge=');
      expect(res.authorize_url).toContain('state=');
      expect(prisma.appUser.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { myIdStatus: 'PENDING' } }),
      );
    });

    it('callback verifies the stub identity and lifts the transaction limit', async () => {
      const svc = new MyIdService(prisma, fakeConfig());
      prisma.myIdSession.findUnique.mockResolvedValue({
        id: 'myid_sess_1',
        userId: 'usr_1',
        state: 'state_abc',
        codeChallenge: 'chal',
        codeVerifier: 'ver',
        redirectUri: 'mator://myid/cb',
        scopes: ['pinfl'],
        expiresAt: new Date(Date.now() + 600_000),
      });
      prisma.authIdentity.findUnique.mockResolvedValue(null);

      const res = await svc.callback('usr_1', {
        session_id: 'myid_sess_1',
        state: 'state_abc',
        code: 'authcode123',
      } as any);

      expect(res.status).toBe('verified');
      expect(res.identity.pinfl).toBe('30101950220011');
      expect(res.transaction_limit_uzs).toBe(50_000_000);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('callback rejects a PINFL already linked to another account', async () => {
      const svc = new MyIdService(prisma, fakeConfig());
      prisma.myIdSession.findUnique.mockResolvedValue({
        id: 'myid_sess_1',
        userId: 'usr_1',
        state: 'state_abc',
        codeVerifier: 'ver',
        redirectUri: 'cb',
        scopes: [],
        expiresAt: new Date(Date.now() + 600_000),
      });
      prisma.authIdentity.findUnique.mockResolvedValue({ userId: 'someone_else' });

      await expect(
        svc.callback('usr_1', { session_id: 'myid_sess_1', state: 'state_abc', code: 'x' } as any),
      ).rejects.toThrow(/already linked/);
    });
  });

  describe('Email (register/login)', () => {
    function buildAuthService(extra: Partial<Record<string, any>> = {}) {
      const { tokens } = realTokens(prisma);
      const emailVerification = { issueAndSend: jest.fn().mockResolvedValue(undefined) };
      const svc = new AuthService(
        prisma,
        fakeConfig(),
        { verify: jest.fn() } as any,
        { verify: jest.fn() } as any,
        new SocialIdentityService(prisma),
        emailVerification as any,
        tokens,
      );
      return { svc, emailVerification, ...extra };
    }

    it('register hashes the password and sends a verification mail, issuing NO tokens', async () => {
      const { svc, emailVerification } = buildAuthService();
      prisma.appUser.findUnique.mockResolvedValue(null);
      prisma.appUser.create.mockResolvedValue(buildAppUser({ email: 'a@b.uz' }));

      const res: any = await svc.register({
        email: 'A@B.uz',
        password: 'Secret123!',
        firstName: 'A',
        lastName: 'B',
      } as any);

      expect(prisma.appUser.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ emailVerified: false }) }),
      );
      const passwordHash = prisma.appUser.create.mock.calls[0][0].data.passwordHash as string;
      expect(passwordHash.startsWith('$argon2')).toBe(true);
      expect(emailVerification.issueAndSend).toHaveBeenCalled();
      expect(res.emailVerified).toBe(false);
      expect(res.accessToken).toBeUndefined();
    });

    it('login is blocked until the email is verified', async () => {
      const { svc } = buildAuthService();
      const passwordHash = await hashPassword('Secret123!');
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ email: 'a@b.uz', passwordHash, emailVerified: false }),
      );
      await expect(svc.login({ email: 'a@b.uz', password: 'Secret123!' } as any)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('login succeeds once verified and returns a real RS256 access token', async () => {
      const { svc } = buildAuthService();
      const passwordHash = await hashPassword('Secret123!');
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ id: 'usr_9', email: 'a@b.uz', passwordHash, emailVerified: true }),
      );
      const res: any = await svc.login({ email: 'a@b.uz', password: 'Secret123!' } as any);
      expect(res.accessToken.split('.')).toHaveLength(3);
      expect(res.refreshToken).toMatch(/^rt_/);
      expect(res.user.passwordHash).toBeUndefined();
    });
  });

  describe('Social (Google/Apple linking)', () => {
    it('Google login links a verified email to a fresh account and issues tokens', async () => {
      const { tokens } = realTokens(prisma);
      const googleVerifier = {
        verify: jest.fn().mockResolvedValue({
          provider: 'GOOGLE',
          providerUserId: 'g-123',
          email: 'g@b.uz',
          emailVerified: true,
          firstName: 'G',
          lastName: 'B',
        }),
      };
      const svc = new AuthService(
        prisma,
        fakeConfig(),
        googleVerifier as any,
        { verify: jest.fn() } as any,
        new SocialIdentityService(prisma),
        { issueAndSend: jest.fn() } as any,
        tokens,
      );
      prisma.authIdentity.findUnique.mockResolvedValue(null); // unknown identity
      prisma.appUser.findUnique.mockResolvedValue(null); // no existing email
      prisma.appUser.create.mockResolvedValue(buildAppUser({ id: 'usr_g', email: 'g@b.uz' }));

      const res: any = await svc.googleLogin({ idToken: 'tok' } as any);
      expect(googleVerifier.verify).toHaveBeenCalledWith('tok');
      expect(res.user.id).toBe('usr_g');
      expect(res.accessToken.split('.')).toHaveLength(3);
    });

    it('a known identity logs straight in without creating a user', async () => {
      const svc = new SocialIdentityService(prisma);
      const user = buildAppUser({ id: 'usr_known' });
      prisma.authIdentity.findUnique.mockResolvedValue({ id: 1, email: 'k@b.uz', user });

      const resolved = await svc.resolveUser({
        provider: 'APPLE' as any,
        providerUserId: 'a-1',
        email: 'k@b.uz',
        emailVerified: true,
      } as any);

      expect(resolved.id).toBe('usr_known');
      expect(prisma.appUser.create).not.toHaveBeenCalled();
    });
  });

  describe('Token revocation (session versioning)', () => {
    /** Sign a real RS256 access token, then verify it back into its payload. */
    async function issueAndDecode(user: { id: string; tokenVersion: number }) {
      const { tokens, keys } = realTokens(prisma);
      const jwt = new JwtService({});
      const { accessToken } = await tokens.issueSession({
        id: user.id,
        email: null,
        role: 'USER',
        tokenVersion: user.tokenVersion,
      });
      const payload = await jwt.verifyAsync<JwtPayload>(accessToken, {
        algorithms: ['RS256'],
        publicKey: keys.publicKey,
        issuer: 'mator',
        audience: 'mator-app',
      });
      return { tokens, keys, payload };
    }

    it('stamps the account session version into every issued access token', async () => {
      const { payload } = await issueAndDecode({ id: 'usr_v', tokenVersion: 7 });
      expect(payload.sub).toBe('usr_v');
      expect(payload.tokenVersion).toBe(7);
    });

    it('accepts a token whose version still matches the account', async () => {
      const { keys, payload } = await issueAndDecode({ id: 'usr_v', tokenVersion: 3 });
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ id: 'usr_v', tokenVersion: 3, passwordHash: 'secret' }),
      );

      const strategy = new JwtStrategy(fakeConfig(), prisma, realTokens(prisma).tokens, keys);
      const authed: any = await strategy.validate({} as any, payload);
      expect(authed.id).toBe('usr_v');
      expect(authed.passwordHash).toBeUndefined();
    });

    it('rejects a token issued before the version was bumped', async () => {
      const { keys, payload } = await issueAndDecode({ id: 'usr_v', tokenVersion: 3 });
      // The account has since been bumped (logout-all / security event).
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ id: 'usr_v', tokenVersion: 4 }),
      );

      const strategy = new JwtStrategy(fakeConfig(), prisma, realTokens(prisma).tokens, keys);
      await expect(strategy.validate({} as any, payload)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(strategy.validate({} as any, payload)).rejects.toThrow('Token revoked');
    });

    // ── Refresh-token version binding ───────────────────────────────────────
    // Rotation reads the account outside a transaction, so a revocation can
    // land between that read and the new refresh row being written. Binding the
    // row to the version it was minted under makes such a row provably stale.
    it('stamps the session version onto the refresh row it creates', async () => {
      const { tokens } = realTokens(prisma);
      await tokens.issueSession({ id: 'usr_v', email: null, role: 'USER', tokenVersion: 4 });

      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'usr_v', tokenVersion: 4 }),
      });
    });

    it('rotates normally while the refresh row and the account agree', async () => {
      const { tokens } = realTokens(prisma);
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 1,
        userId: 'usr_v',
        deviceId: 'dev_1',
        tokenVersion: 2,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: buildAppUser({ id: 'usr_v', tokenVersion: 2 }),
      });
      prisma.refreshToken.update.mockResolvedValue({});

      const rotated = await tokens.rotate('rt_valid');
      expect(rotated.accessToken.split('.')).toHaveLength(3);
      expect(rotated.refreshToken).toMatch(/^rt_/);
      // Consumed (not deleted), so a later replay is still detectable as reuse.
      expect(prisma.refreshToken.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
      );
      // The replacement row carries the account's current version.
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tokenVersion: 2 }),
      });
    });

    it('rejects a refresh token minted before logout-all bumped the account', async () => {
      const { tokens } = realTokens(prisma);
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 1,
        userId: 'usr_v',
        tokenVersion: 0, // minted pre-revocation
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: buildAppUser({ id: 'usr_v', tokenVersion: 1 }), // logout-all ran
      });
      prisma.refreshToken.delete.mockResolvedValue({});

      await expect(tokens.rotate('rt_stale')).rejects.toThrow('Refresh token revoked');
      // No replacement session is minted, and the dead row is swept.
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('a refresh row created in the revocation race cannot revive the session', async () => {
      const { tokens } = realTokens(prisma);
      // Replay the race: rotate() read the account at version 0, logout-all then
      // swept + bumped to 1, and only afterwards did rotate() write its row —
      // so the row survived the sweep, carrying the pre-bump version.
      let raceRow: any;
      prisma.refreshToken.create.mockImplementation(({ data }: any) => {
        raceRow = { id: 9, ...data, consumedAt: null };
        return Promise.resolve(raceRow);
      });
      await tokens.issueSession({ id: 'usr_v', email: null, role: 'USER', tokenVersion: 0 });
      expect(raceRow.tokenVersion).toBe(0);

      // The attacker now presents that surviving refresh token.
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...raceRow,
        user: buildAppUser({ id: 'usr_v', tokenVersion: 1 }),
      });
      prisma.refreshToken.delete.mockResolvedValue({});
      prisma.refreshToken.create.mockClear();

      await expect(tokens.rotate('rt_race')).rejects.toThrow('Refresh token revoked');
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    // ── Reuse detection = full compromise ───────────────────────────────────
    // A replayed refresh token means the credential leaked, so it escalates to
    // the same revocation logout-all performs — not just a refresh-family wipe,
    // which would leave the attacker's access token alive for its whole TTL.
    it('refresh reuse revokes every session, not just the refresh family', async () => {
      const { tokens, keys } = realTokens(prisma);
      const jwt = new JwtService({});
      // The token the attacker (or victim) is already holding.
      const { accessToken } = await tokens.issueSession({
        id: 'usr_v',
        email: null,
        role: 'USER',
        tokenVersion: 0,
      });
      const disconnected: string[] = [];
      tokens.onSessionsRevoked((userId) => disconnected.push(userId));

      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 1,
        userId: 'usr_v',
        tokenVersion: 0,
        consumedAt: new Date(), // already rotated once -> replay
        expiresAt: new Date(Date.now() + 60_000),
        user: buildAppUser({ id: 'usr_v', tokenVersion: 0 }),
      });
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 2 });
      prisma.appUser.update.mockResolvedValue({ tokenVersion: 1 });
      prisma.refreshToken.create.mockClear();

      await expect(tokens.rotate('rt_replayed')).rejects.toThrow(
        'Refresh token reuse detected',
      );

      // 1. refresh family dropped
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'usr_v' },
      });
      // 2. access tokens killed via the version bump
      expect(prisma.appUser.update).toHaveBeenCalledWith({
        where: { id: 'usr_v' },
        data: { tokenVersion: { increment: 1 } },
        select: { tokenVersion: true },
      });
      // 3. realtime sessions revoked
      expect(disconnected).toEqual(['usr_v']);
      // …and no replacement session is handed out.
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();

      // The access token minted before the replay no longer authenticates.
      const payload = await jwt.verifyAsync<JwtPayload>(accessToken, {
        algorithms: ['RS256'],
        publicKey: keys.publicKey,
        issuer: 'mator',
        audience: 'mator-app',
      });
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ id: 'usr_v', tokenVersion: 1 }), // post-revocation state
      );
      const strategy = new JwtStrategy(fakeConfig(), prisma, realTokens(prisma).tokens, keys);
      await expect(strategy.validate({} as any, payload)).rejects.toThrow('Token revoked');
    });

    it('incrementTokenVersion bumps atomically and returns the new version', async () => {
      const { tokens } = realTokens(prisma);
      prisma.appUser.update.mockResolvedValue({ tokenVersion: 5 });

      await expect(tokens.incrementTokenVersion('usr_v')).resolves.toBe(5);
      expect(prisma.appUser.update).toHaveBeenCalledWith({
        where: { id: 'usr_v' },
        data: { tokenVersion: { increment: 1 } },
        select: { tokenVersion: true },
      });
    });

    it('revokeAllSessions drops the refresh family BEFORE bumping the version', async () => {
      const { tokens } = realTokens(prisma);
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 2 });
      prisma.appUser.update.mockResolvedValue({ tokenVersion: 1 });

      await expect(tokens.revokeAllSessions('usr_v')).resolves.toBe(1);
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'usr_v' } });
      // Order matters: a refresh racing in between would only mint a token
      // carrying the stale version, which the next request rejects.
      const deleteOrder = prisma.refreshToken.deleteMany.mock.invocationCallOrder[0];
      const bumpOrder = prisma.appUser.update.mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(bumpOrder);
    });

    it('revokeAllSessions notifies transports once the writes are committed', async () => {
      const { tokens } = realTokens(prisma);
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
      prisma.appUser.update.mockResolvedValue({ tokenVersion: 1 });
      const disconnected: string[] = [];
      tokens.onSessionsRevoked((userId) => disconnected.push(userId));

      await tokens.revokeAllSessions('usr_v');
      expect(disconnected).toEqual(['usr_v']);
    });

    it('revokeAllSessions enlists in a caller transaction and defers the notify', async () => {
      const { tokens } = realTokens(prisma);
      const tx = { refreshToken: { deleteMany: jest.fn() }, appUser: { update: jest.fn() } };
      tx.appUser.update.mockResolvedValue({ tokenVersion: 3 });
      const disconnected: string[] = [];
      tokens.onSessionsRevoked((userId) => disconnected.push(userId));

      await expect(tokens.revokeAllSessions('usr_v', tx as any)).resolves.toBe(3);
      // Both writes go through the caller's transaction, not the base client.
      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'usr_v' } });
      expect(tx.appUser.update).toHaveBeenCalled();
      expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
      expect(prisma.appUser.update).not.toHaveBeenCalled();
      // Deferred: firing pre-commit would let a client reconnect against state
      // that still says its token is good. The caller fires it after commit.
      expect(disconnected).toEqual([]);
      tokens.notifySessionsRevoked('usr_v');
      expect(disconnected).toEqual(['usr_v']);
    });

    it('a failing revocation listener never breaks the revocation', async () => {
      const { tokens } = realTokens(prisma);
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
      prisma.appUser.update.mockResolvedValue({ tokenVersion: 1 });
      tokens.onSessionsRevoked(() => {
        throw new Error('socket layer exploded');
      });
      const reached: string[] = [];
      tokens.onSessionsRevoked((userId) => reached.push(userId));

      await expect(tokens.revokeAllSessions('usr_v')).resolves.toBe(1);
      expect(reached).toEqual(['usr_v']); // later listeners still run
    });

    it('a confirmed phone change kills the access tokens issued before it', async () => {
      const { tokens, keys } = realTokens(prisma);
      const jwt = new JwtService({});
      const verify = (token: string) =>
        jwt.verifyAsync<JwtPayload>(token, {
          algorithms: ['RS256'],
          publicKey: keys.publicKey,
          issuer: 'mator',
          audience: 'mator-app',
        });

      // The session the user is holding while they change their number.
      const old = await tokens.issueSession({
        id: 'usr_v',
        email: null,
        role: 'USER',
        tokenVersion: 0,
      });

      const otp = { verifyLatestForPhone: jest.fn().mockResolvedValue(undefined) };
      const phoneChange = new PhoneChangeService(prisma, otp as any, tokens);
      const before = buildAppUser({ id: 'usr_v', phoneE164: '+998901112233' });
      prisma.appUser.findUnique
        .mockResolvedValueOnce(before) // caller, before the transaction
        .mockResolvedValueOnce(before) // re-read under the row lock
        .mockResolvedValueOnce(null); // new number is free
      prisma.appUser.update
        .mockResolvedValueOnce(
          buildAppUser({ id: 'usr_v', phoneE164: '+998907778899', tokenVersion: 0 }),
        ) // the phone update still reads the PRE-bump version
        .mockResolvedValueOnce({ tokenVersion: 1 }); // incrementTokenVersion
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });

      const res = await phoneChange.confirm('usr_v', '+998907778899', '123456');

      // The account is now at version 1 — that is what every later request reads.
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ id: 'usr_v', tokenVersion: 1 }),
      );
      const strategy = new JwtStrategy(fakeConfig(), prisma, tokens, keys);

      // Old token: signature and expiry are still fine, the version is not.
      await expect(strategy.validate({} as any, await verify(old.accessToken))).rejects.toThrow(
        'Token revoked',
      );
      // The pair handed back by the flow carries the bumped version and works,
      // so the client swaps tokens and never sees a forced re-login.
      const fresh = await verify(res.tokens.access_token);
      expect(fresh.tokenVersion).toBe(1);
      await expect(strategy.validate({} as any, fresh)).resolves.toMatchObject({ id: 'usr_v' });
    });

    it('POST /v1/auth/logout-all revokes every session for the caller', async () => {
      const tokens = { revokeAllSessions: jest.fn().mockResolvedValue(2) };
      const controller = new AuthController({} as any, {} as any, tokens as any);

      const res = await controller.logoutAll({ user: { id: 'usr_v' } });
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith('usr_v');
      expect(res).toEqual({ message: 'All sessions revoked', token_version: 2 });
    });
  });

  // Single-token logout via Redis blacklist. Complements session versioning
  // above: logout-all bumps the version (kills every token); logout blacklists
  // just this token's jti, so every *other* token keeps working.
  describe('JWT access-token blacklist (single-token logout)', () => {
    const NOW = Math.floor(Date.now() / 1000);

    /** Sign a real access token and decode it back, sharing one Redis + keys. */
    async function issue(user: { id: string; tokenVersion: number }) {
      const redis = fakeRedis();
      const { tokens, keys } = realTokens(prisma, redis);
      const jwt = new JwtService({});
      const { accessToken } = await tokens.issueSession({
        id: user.id,
        email: null,
        role: 'USER',
        tokenVersion: user.tokenVersion,
      });
      const payload = await jwt.verifyAsync<JwtPayload>(accessToken, {
        algorithms: ['RS256'],
        publicKey: keys.publicKey,
        issuer: 'mator',
        audience: 'mator-app',
      });
      return { tokens, keys, redis, payload };
    }

    it('every issued access token carries a unique jti', async () => {
      const a = await issue({ id: 'usr_b', tokenVersion: 0 });
      const b = await issue({ id: 'usr_b', tokenVersion: 0 });
      expect(a.payload.jti).toBeDefined();
      expect(b.payload.jti).toBeDefined();
      expect(a.payload.jti).not.toBe(b.payload.jti);
    });

    it('logout blacklists the token under RedisKeys.jwtBlacklist(jti) with the token TTL', async () => {
      const { tokens, redis, payload } = await issue({ id: 'usr_b', tokenVersion: 0 });

      await tokens.blacklistAccessToken(payload.jti, payload.exp);

      const key = RedisKeys.jwtBlacklist(payload.jti!);
      expect(redis.store.has(key)).toBe(true);
      // TTL is the token's own remaining lifetime (~1h), never negative.
      const ttl = redis.ttls.get(key)!;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(payload.exp! - NOW + 1);
    });

    it('a blacklisted token is rejected exactly like an invalid JWT', async () => {
      const { tokens, keys, payload } = await issue({ id: 'usr_b', tokenVersion: 0 });
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ id: 'usr_b', tokenVersion: 0 }),
      );
      await tokens.blacklistAccessToken(payload.jti, payload.exp);

      const strategy = new JwtStrategy(fakeConfig(), prisma, tokens, keys);
      await expect(strategy.validate({} as any, payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(strategy.validate({} as any, payload)).rejects.toThrow('Token revoked');
    });

    it('a non-blacklisted token still authenticates (only that one jti dies)', async () => {
      const { tokens, keys, payload } = await issue({ id: 'usr_b', tokenVersion: 0 });
      const other = await issue({ id: 'usr_b', tokenVersion: 0 }); // different jti
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ id: 'usr_b', tokenVersion: 0, passwordHash: 'secret' }),
      );
      // Blacklist only the first token, on ITS redis.
      await tokens.blacklistAccessToken(payload.jti, payload.exp);

      // The other token, checked against the same shared appUser mock, still works.
      const strategy = new JwtStrategy(
        fakeConfig(),
        prisma,
        other.tokens,
        other.keys,
      );
      const authed: any = await strategy.validate({} as any, other.payload);
      expect(authed.id).toBe('usr_b');
      expect(authed.passwordHash).toBeUndefined();
    });

    it('an already-expired token is never written to Redis (no client timestamps trusted)', async () => {
      const { tokens, redis, payload } = await issue({ id: 'usr_b', tokenVersion: 0 });
      // exp in the past → nothing to blacklist (it is already rejected by exp).
      await tokens.blacklistAccessToken(payload.jti, NOW - 10);
      expect(redis.store.size).toBe(0);
      expect(redis.setEx).not.toHaveBeenCalled();
    });

    it('a missing jti/exp is a no-op (legacy tokens rely on the version check)', async () => {
      const { tokens, redis } = await issue({ id: 'usr_b', tokenVersion: 0 });
      await tokens.blacklistAccessToken(undefined, NOW + 3600);
      await tokens.blacklistAccessToken('jti_x', undefined);
      expect(redis.setEx).not.toHaveBeenCalled();
    });

    it('the blacklist entry disappears once Redis expires it (TTL is the only cleanup)', async () => {
      const { tokens, keys, redis, payload } = await issue({ id: 'usr_b', tokenVersion: 0 });
      prisma.appUser.findUnique.mockResolvedValue(
        buildAppUser({ id: 'usr_b', tokenVersion: 0 }),
      );
      await tokens.blacklistAccessToken(payload.jti, payload.exp);
      const key = RedisKeys.jwtBlacklist(payload.jti!);

      // Simulate Redis evicting the key at TTL expiry (no cron, no code path).
      redis.store.delete(key);
      redis.ttls.delete(key);

      const strategy = new JwtStrategy(fakeConfig(), prisma, tokens, keys);
      // With the entry gone, the (still unexpired-by-signature) token is accepted.
      await expect(strategy.validate({} as any, payload)).resolves.toMatchObject({
        id: 'usr_b',
      });
    });

    it('lookup is a single Redis EXISTS call — no SCAN/KEYS', async () => {
      const { tokens, redis, payload } = await issue({ id: 'usr_b', tokenVersion: 0 });
      await tokens.isAccessTokenBlacklisted(payload.jti);
      expect(redis.exists).toHaveBeenCalledTimes(1);
      expect(redis.exists).toHaveBeenCalledWith(RedisKeys.jwtBlacklist(payload.jti!));
      expect(redis.scan).toBeUndefined(); // fakeRedis has no scan; prod never calls it
    });
  });
});
