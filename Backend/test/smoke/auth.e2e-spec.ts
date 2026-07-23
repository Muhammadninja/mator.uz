import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OtpService } from '../../src/auth/phone/otp.service';
import { PhoneAuthService } from '../../src/auth/phone/phone-auth.service';
import { MyIdService } from '../../src/auth/myid/myid.service';
import { AuthService } from '../../src/auth/auth.service';
import { SocialIdentityService } from '../../src/auth/social/social-identity.service';
import { TokenService } from '../../src/auth/tokens/token.service';
import { JwtKeyService } from '../../src/auth/tokens/jwt-key.service';
import { hashPassword } from '../../src/auth/password.util';
import { createPrismaMock, fakeConfig, buildAppUser, PrismaMock } from '../utils/harness';

/** Real token service (ephemeral RS256 keypair) for end-to-end token integration. */
function realTokens(prisma: PrismaMock) {
  const keys = new JwtKeyService(fakeConfig());
  const tokens = new TokenService(prisma, new JwtService({}), keys, fakeConfig());
  prisma.refreshToken.create.mockResolvedValue({ id: 'rt_row' });
  return { tokens, keys };
}

describe('Auth smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  describe('Phone OTP', () => {
    it('issues, then verifies the exact code that was sent', async () => {
      const sms = { sendSms: jest.fn().mockResolvedValue(undefined) };
      // No AUTH_DEV_MODE → production path: SMS is sent, no dev code returned.
      const otp = new OtpService(prisma, sms as any, fakeConfig());
      const phone = '+998901112233';

      let created: any;
      prisma.phoneOtpRequest.count.mockResolvedValue(0);
      prisma.phoneOtpRequest.create.mockImplementation(({ data }: any) => {
        created = { ...data, consumedAt: null, attempts: 0, lastSentAt: new Date() };
        return Promise.resolve(created);
      });

      const issued = await otp.request(phone);
      expect(issued.otpLength).toBe(6);
      expect(sms.sendSms).toHaveBeenCalledTimes(1);

      const code = /(\d{6})/.exec(sms.sendSms.mock.calls[0][1])![1];
      prisma.phoneOtpRequest.findUnique.mockResolvedValue(created);
      prisma.phoneOtpRequest.update.mockResolvedValue({});
      // Consume is an atomic guarded updateMany (single-use race protection).
      prisma.phoneOtpRequest.updateMany.mockResolvedValue({ count: 1 });

      await expect(otp.verify(issued.requestId, phone, code)).resolves.toBeUndefined();
      expect(prisma.phoneOtpRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ consumedAt: null }),
          data: expect.objectContaining({ consumedAt: expect.any(Date) }),
        }),
      );
    });

    it('rejects an incorrect code and counts the attempt', async () => {
      const sms = { sendSms: jest.fn().mockResolvedValue(undefined) };
      const otp = new OtpService(prisma, sms as any, fakeConfig());
      const phone = '+998901112233';
      let created: any;
      prisma.phoneOtpRequest.count.mockResolvedValue(0);
      prisma.phoneOtpRequest.create.mockImplementation(({ data }: any) =>
        Promise.resolve((created = { ...data, consumedAt: null, attempts: 0 })),
      );
      const issued = await otp.request(phone);
      prisma.phoneOtpRequest.findUnique.mockResolvedValue(created);
      prisma.phoneOtpRequest.update.mockResolvedValue({});

      await expect(otp.verify(issued.requestId, phone, '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.phoneOtpRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { attempts: { increment: 1 } } }),
      );
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
});
