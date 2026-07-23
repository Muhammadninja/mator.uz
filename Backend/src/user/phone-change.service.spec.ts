// Unit tests for PhoneChangeService (change-phone flow). Prisma, OtpService and
// TokenService are mocked. These guard: no-op rejection (same number), taken-by-
// another-user rejection, OTP isolation (phone_change purpose), full field
// update on confirm, and session revocation after a successful change.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { PhoneChangeService } from './phone-change.service';
import { OtpPurpose } from '../auth/phone/otp.service';

/** The envelope the (mocked) TokenService hands back for a fresh session. */
const SESSION = {
  accessToken: 'access.jwt',
  accessTokenExpiresAt: new Date('2026-07-23T11:00:00.000Z'),
  refreshToken: 'rt_new',
  refreshTokenExpiresAt: new Date('2026-10-21T10:00:00.000Z'),
  tokenType: 'Bearer',
};

/**
 * Prisma double whose `$transaction` hands the callback a DISTINCT `tx` client,
 * so tests can prove the phone write and the revocation were enlisted in the
 * transaction rather than run on the base client, and flips `committed` only
 * once the callback resolves (i.e. at commit time).
 */
function makePrisma() {
  const prisma = {
    appUser: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    tx: {
      // `SELECT … FOR UPDATE` — the account row lock the confirm opens with.
      $queryRaw: jest.fn().mockResolvedValue([]),
      appUser: { findUnique: jest.fn(), update: jest.fn() },
    },
    committed: false,
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb(prisma.tx);
      prisma.committed = true;
      return result;
    }),
  };
  return prisma;
}

function makeOtp() {
  return {
    request: jest.fn().mockResolvedValue({
      requestId: 'otp_1',
      expiresAt: new Date('2026-07-23T10:05:00.000Z'),
      resendAfterSeconds: 60,
      otpLength: 6,
      channel: OtpChannel.SMS,
    }),
    verifyLatestForPhone: jest.fn().mockResolvedValue(undefined),
  };
}

function makeTokens() {
  return {
    // Single revocation entry point; the account sits at version 0 before the
    // change, so the bump returns 1.
    revokeAllSessions: jest.fn().mockResolvedValue(1),
    notifySessionsRevoked: jest.fn(),
    issueSession: jest.fn().mockResolvedValue(SESSION),
  };
}

function build() {
  const prisma = makePrisma();
  const otp = makeOtp();
  const tokens = makeTokens();
  const service = new PhoneChangeService(
    prisma as never,
    otp as never,
    tokens as never,
  );
  return { service, prisma, otp, tokens };
}

const CURRENT = '+998900000000';
const NEW = '+998901234567';

describe('PhoneChangeService', () => {
  describe('request()', () => {
    it('issues a phone_change OTP for an available number', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique
        .mockResolvedValueOnce({ id: 'u1', phoneE164: CURRENT }) // caller
        .mockResolvedValueOnce(null); // availability check: nobody owns NEW

      const res = await service.request('u1', NEW);

      expect(otp.request).toHaveBeenCalledWith(
        NEW,
        OtpChannel.SMS,
        OtpPurpose.PHONE_CHANGE,
      );
      expect(res.phone).toBe(NEW);
      expect(res.otp_length).toBe(6);
      expect(res.delivery_channel).toBe('sms');
    });

    it('rejects when the new number equals the current one', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: NEW,
      });

      await expect(service.request('u1', NEW)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(otp.request).not.toHaveBeenCalled();
    });

    it('rejects when the number belongs to another user', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique
        .mockResolvedValueOnce({ id: 'u1', phoneE164: CURRENT })
        .mockResolvedValueOnce({ id: 'someone_else', phoneE164: NEW });

      await expect(service.request('u1', NEW)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(otp.request).not.toHaveBeenCalled();
    });

    it('404s for an unknown caller', async () => {
      const { service, prisma } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce(null);
      await expect(service.request('ghost', NEW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('normalizes an input with spaces/dashes to canonical E.164', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique
        .mockResolvedValueOnce({ id: 'u1', phoneE164: CURRENT })
        .mockResolvedValueOnce(null);

      await service.request('u1', '+998 90 123-45-67');
      expect(otp.request).toHaveBeenCalledWith(
        NEW,
        OtpChannel.SMS,
        OtpPurpose.PHONE_CHANGE,
      );
    });
  });

  describe('confirm()', () => {
    /**
     * Stub the two reads the confirm transaction makes under the row lock: the
     * re-read of the account, then the availability check for the target number.
     */
    function lockReads(
      prisma: ReturnType<typeof makePrisma>,
      locked: unknown,
      owner: unknown = null,
    ) {
      prisma.tx.appUser.findUnique
        .mockResolvedValueOnce(locked)
        .mockResolvedValueOnce(owner);
    }

    it('verifies the OTP, updates all phone fields, rotates tokens (revoke → issue) and returns a fresh pair', async () => {
      const { service, prisma, otp, tokens } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: CURRENT,
      });
      lockReads(prisma, { id: 'u1', phoneE164: CURRENT });
      prisma.tx.appUser.update.mockResolvedValue({
        id: 'u1',
        phoneE164: NEW,
        phoneVerified: true,
        email: null,
        emailVerified: false,
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: null,
        thumbnailUrl: null,
        role: 'USER',
        language: 'UZ',
        myIdStatus: 'NOT_VERIFIED',
        transactionLimitUzs: 0,
        tokenVersion: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-07-23T10:00:00Z'),
      });

      const res = await service.confirm('u1', NEW, '123456');

      expect(otp.verifyLatestForPhone).toHaveBeenCalledWith(
        NEW,
        '123456',
        OtpPurpose.PHONE_CHANGE,
      );
      // The transaction opens by taking the account's row lock, before it reads
      // or writes anything — that is what serializes concurrent confirmations.
      expect(prisma.tx.$queryRaw).toHaveBeenCalled();
      const lockSql = (prisma.tx.$queryRaw.mock.calls[0][0] as string[]).join('');
      expect(lockSql).toContain('FOR UPDATE');
      expect(
        prisma.tx.$queryRaw.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.tx.appUser.findUnique.mock.invocationCallOrder[0]);
      // The phone write is enlisted in the transaction, not run on the base
      // client — so it commits together with the revocation or not at all.
      expect(prisma.tx.appUser.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { phoneE164: NEW, phoneVerified: true },
      });
      expect(prisma.appUser.update).not.toHaveBeenCalled();
      // One revocation entry point, enlisted in the same transaction; the fresh
      // pair then carries the BUMPED version (1), not the stale 0 read off the
      // updated row, or the token would be born invalid.
      expect(tokens.revokeAllSessions).toHaveBeenCalledWith('u1', prisma.tx);
      expect(tokens.issueSession).toHaveBeenCalledWith({
        id: 'u1',
        email: null,
        role: 'USER',
        tokenVersion: 1,
      });
      const revokeOrder = tokens.revokeAllSessions.mock.invocationCallOrder[0];
      const issueOrder = tokens.issueSession.mock.invocationCallOrder[0];
      expect(revokeOrder).toBeLessThan(issueOrder);
      // Sockets are dropped only once the transaction is committed, so a client
      // cannot reconnect against pre-commit state and keep its channel.
      expect(tokens.notifySessionsRevoked).toHaveBeenCalledWith('u1');

      // Returns updated user + a fresh snake_case token envelope.
      expect(res.user.phone_e164).toBe(NEW);
      expect(res.user.phone_verified).toBe(true);
      expect(res.tokens).toEqual({
        access_token: 'access.jwt',
        access_token_expires_at: '2026-07-23T11:00:00.000Z',
        refresh_token: 'rt_new',
        refresh_token_expires_at: '2026-10-21T10:00:00.000Z',
        token_type: 'Bearer',
      });
    });

    it('signs the new token only AFTER the transaction commits', async () => {
      const { service, prisma, tokens } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: CURRENT,
      });
      lockReads(prisma, { id: 'u1', phoneE164: CURRENT });
      prisma.tx.appUser.update.mockResolvedValue({
        id: 'u1',
        phoneE164: NEW,
        phoneVerified: true,
        email: null,
        emailVerified: false,
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: null,
        thumbnailUrl: null,
        role: 'USER',
        language: 'UZ',
        myIdStatus: 'NOT_VERIFIED',
        transactionLimitUzs: 0,
        tokenVersion: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-07-23T10:00:00Z'),
      });

      // Record the transaction state at the moment the JWT would be signed —
      // holding a transaction open across token signing pins a DB connection
      // for pure CPU work.
      const committedAt: Record<string, boolean> = {};
      tokens.revokeAllSessions.mockImplementation(async () => {
        committedAt.revoke = prisma.committed;
        return 1;
      });
      tokens.issueSession.mockImplementation(async () => {
        committedAt.issue = prisma.committed;
        return SESSION;
      });

      await service.confirm('u1', NEW, '123456');

      expect(committedAt.revoke).toBe(false); // inside the transaction
      expect(committedAt.issue).toBe(true); // after it committed
    });

    it('does not update or revoke when the OTP is invalid', async () => {
      const { service, prisma, otp, tokens } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: CURRENT,
      });
      otp.verifyLatestForPhone.mockRejectedValue(
        new BadRequestException('bad'),
      );

      await expect(service.confirm('u1', NEW, '000000')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.tx.appUser.update).not.toHaveBeenCalled();
      expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('rejects when the number was claimed between request and confirm', async () => {
      const { service, prisma, tokens } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: CURRENT,
      });
      // Checked under the row lock now: the target belongs to someone else.
      lockReads(
        prisma,
        { id: 'u1', phoneE164: CURRENT },
        { id: 'other', phoneE164: NEW },
      );

      await expect(service.confirm('u1', NEW, '123456')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.tx.appUser.update).not.toHaveBeenCalled();
      expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('rejects a confirm whose account phone moved while it was in flight', async () => {
      const { service, prisma, tokens } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: CURRENT,
      });
      // A competing confirmation won the lock first and moved the account
      // somewhere else — this OTP authorized a move away from CURRENT.
      lockReads(prisma, { id: 'u1', phoneE164: '+998905554433' });

      await expect(service.confirm('u1', NEW, '123456')).rejects.toThrow(
        /changed while this request was in flight/,
      );
      expect(prisma.tx.appUser.update).not.toHaveBeenCalled();
      expect(tokens.revokeAllSessions).not.toHaveBeenCalled();
      // No token is handed back at all, let alone a stale-version one.
      expect(tokens.issueSession).not.toHaveBeenCalled();
    });

    it('rejects a no-op confirm (already the current number)', async () => {
      const { service, prisma, otp } = build();
      prisma.appUser.findUnique.mockResolvedValueOnce({
        id: 'u1',
        phoneE164: NEW,
      });

      await expect(service.confirm('u1', NEW, '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(otp.verifyLatestForPhone).not.toHaveBeenCalled();
    });
  });

  // ── Concurrent confirmations ────────────────────────────────────────────────
  describe('confirm() under concurrency', () => {
    const OTHER = '+998907778899';

    /**
     * Prisma double backed by ONE mutable account row, where `$transaction`
     * bodies run strictly one after another — the behaviour `SELECT … FOR
     * UPDATE` buys us in Postgres. Reads inside a transaction see whatever the
     * previous one committed, which is exactly the state the second confirm has
     * to notice. Without the lock both bodies would interleave against the same
     * pre-change snapshot.
     */
    function makeSerializedPrisma() {
      const row = {
        id: 'u1',
        phoneE164: CURRENT,
        phoneVerified: true,
        email: null,
        emailVerified: false,
        displayName: null,
        firstName: null,
        lastName: null,
        avatarUrl: null,
        thumbnailUrl: null,
        role: 'USER',
        language: 'UZ',
        myIdStatus: 'NOT_VERIFIED',
        transactionLimitUzs: 0,
        tokenVersion: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-07-23T10:00:00Z'),
      };
      const locksTaken: string[] = [];
      const tx = {
        $queryRaw: jest.fn(async () => {
          locksTaken.push(row.phoneE164);
          return [];
        }),
        appUser: {
          // The account re-read, and the availability check for the target
          // number (nobody else owns anything in this scenario).
          findUnique: jest.fn(async ({ where }: { where: { id?: string } }) =>
            where.id === 'u1' ? { ...row } : null,
          ),
          update: jest.fn(async ({ data }: { data: { phoneE164: string } }) => {
            row.phoneE164 = data.phoneE164;
            return { ...row };
          }),
        },
      };
      let queue: Promise<unknown> = Promise.resolve();
      const prisma = {
        appUser: {
          findUnique: jest.fn(async () => ({ ...row })),
          update: jest.fn(),
        },
        tx,
        $transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => {
          const run = queue.then(() => cb(tx));
          queue = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        }),
      };
      return { prisma, row, locksTaken };
    }

    function buildConcurrent() {
      const { prisma, row, locksTaken } = makeSerializedPrisma();
      const otp = makeOtp();
      // The bump is the same row the transactions share, so a token minted with
      // a stale version is detectable by comparing against the final value.
      const tokens = {
        revokeAllSessions: jest.fn(async () => ++row.tokenVersion),
        notifySessionsRevoked: jest.fn(),
        issueSession: jest.fn(
          async (user: { tokenVersion: number }) => ({
            ...SESSION,
            accessToken: `access.v${user.tokenVersion}`,
          }),
        ),
      };
      const service = new PhoneChangeService(
        prisma as never,
        otp as never,
        tokens as never,
      );
      return { service, prisma, row, tokens, locksTaken };
    }

    it('serializes two confirmations for the same user: exactly one wins', async () => {
      const { service, row, tokens, locksTaken } = buildConcurrent();

      // Two DIFFERENT target numbers, each with its own valid OTP, fired
      // together. Both read the same "current" number before their transaction.
      const results = await Promise.allSettled([
        service.confirm('u1', NEW, '111111'),
        service.confirm('u1', OTHER, '222222'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The loser gets a real error, not a 200 carrying a dead token.
      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(ConflictException);
      expect(String(err)).toMatch(/changed while this request was in flight/);

      // Deterministic final state: the winner is whoever took the lock first,
      // and the account ends on that number with a single version bump.
      expect(row.phoneE164).toBe(NEW);
      expect(row.tokenVersion).toBe(1);
      expect(tokens.revokeAllSessions).toHaveBeenCalledTimes(1);

      // Both attempts took the account lock; the second one saw post-commit
      // state (the number the winner had already written).
      expect(locksTaken).toEqual([CURRENT, NEW]);
    });

    it('the surviving response carries a token minted at the FINAL version', async () => {
      const { service, row, tokens } = buildConcurrent();

      const results = await Promise.allSettled([
        service.confirm('u1', NEW, '111111'),
        service.confirm('u1', OTHER, '222222'),
      ]);
      const winner = results.find((r) => r.status === 'fulfilled');
      const res = (winner as PromiseFulfilledResult<any>).value;

      // Exactly one token was ever signed, and its version is the account's
      // current one — no 200 hands back a version the next bump already killed.
      expect(tokens.issueSession).toHaveBeenCalledTimes(1);
      const issuedWith = tokens.issueSession.mock.calls[0][0].tokenVersion;
      expect(issuedWith).toBe(row.tokenVersion);
      expect(res.tokens.access_token).toBe(`access.v${row.tokenVersion}`);
      expect(res.user.phone_e164).toBe(row.phoneE164);
    });
  });
});
