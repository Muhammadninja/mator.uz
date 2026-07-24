import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis.keys';
import { JwtKeyService } from './jwt-key.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

export const ACCESS_TTL_SECONDS = 60 * 60; // 1h (matches the mobile contract)
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90d
const ISSUER = 'mator';

export interface SessionUser {
  id: string;
  email: string | null;
  role: string;
  /** Current AppUser.tokenVersion — stamped into the access token (see below). */
  tokenVersion: number;
}

/**
 * Called after a user's sessions are revoked, so transports holding state that
 * outlives a single HTTP request (today: live WebSockets) can drop it. Best
 * effort and synchronous-fire-and-forget — a listener must never break the
 * revocation itself.
 */
export type SessionRevocationListener = (userId: string) => void;

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string; // opaque rt_… (raw, returned to client only)
  refreshTokenExpiresAt: Date;
  tokenType: 'Bearer';
}

/**
 * Single source of truth for token issuance across ALL auth flows
 * (phone OTP, MyID, email, Google, Apple):
 *   • access  = RS256 JWT with a `kid` header (rotation/JWKS ready), carrying
 *               the account's session version (`tokenVersion`) so live tokens
 *               can be revoked without any session store.
 *   • refresh = opaque random `rt_…`, stored only as a SHA-256 hash, rotated on
 *               every use with reuse detection (soft-consume via consumedAt),
 *               and bound to the same session version so a revoked family can
 *               never rotate its way back to a valid session.
 *
 * Revocation has exactly one entry point: {@link TokenService.revokeAllSessions}.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly revocationListeners: SessionRevocationListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly keys: JwtKeyService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Run against the caller's transaction when one is supplied, otherwise
   * straight against the client (each statement auto-commits).
   */
  private db(tx?: Prisma.TransactionClient): Prisma.TransactionClient {
    return tx ?? this.prisma;
  }

  private async signAccessToken(user: SessionUser): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
      // Per-token id, so an individual access token can be blacklisted on logout
      // (see blacklistAccessToken). `exp` is added by the signer via expiresIn.
      jti: randomUUID(),
    };
    return this.jwt.signAsync(payload, {
      algorithm: 'RS256',
      privateKey: this.keys.privateKey,
      keyid: this.keys.kid, // sets the JWT `kid` header
      expiresIn: ACCESS_TTL_SECONDS,
      issuer: ISSUER,
      audience: this.config.get<string>('JWT_AUDIENCE') ?? 'mator-app',
    });
  }

  /** Issue a fresh access + opaque refresh pair, optionally bound to a device. */
  async issueSession(user: SessionUser, opts?: { deviceId?: string | null }): Promise<IssuedSession> {
    const accessToken = await this.signAccessToken(user);
    const rawRefresh = `rt_${randomBytes(32).toString('base64url')}`;
    const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hash(rawRefresh),
        userId: user.id,
        deviceId: opts?.deviceId ?? null,
        // Bind the row to the version it was minted under, so a revocation that
        // lands between this call reading the account and this row being written
        // leaves the row provably stale instead of silently valid.
        tokenVersion: user.tokenVersion,
        expiresAt: refreshTokenExpiresAt,
      },
    });

    return {
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000),
      refreshToken: rawRefresh,
      refreshTokenExpiresAt,
      tokenType: 'Bearer',
    };
  }

  /** Rotate: validate the presented refresh token and issue a new pair. */
  async rotate(rawRefresh: string, opts?: { deviceId?: string | null }): Promise<IssuedSession> {
    const tokenHash = this.hash(rawRefresh);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Already rotated once -> replay/theft. A replayed refresh token means the
    // credential is in someone else's hands, so this is a full compromise
    // signal, not just a bad refresh: revoke EVERYTHING (refresh family, live
    // access tokens via the version bump, and open realtime sockets) rather
    // than only the refresh rows, which would leave the attacker's access
    // token working for up to its full TTL.
    if (stored.consumedAt) {
      await this.revokeAllSessions(stored.userId);
      this.logger.warn(
        `Refresh reuse detected for user ${stored.userId}; all sessions revoked`,
      );
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    // Revoked family: the account's session version moved on since this row was
    // minted. Covers both the ordinary case (a row that outlived a revocation)
    // and the race one — a rotation whose `create` landed *after* a revocation's
    // sweep still stamped the pre-bump version, so it can never revive a session
    // that logout-all / phone-change already killed.
    if (stored.tokenVersion !== stored.user.tokenVersion) {
      await this.prisma.refreshToken.delete({ where: { id: stored.id } });
      this.logger.warn(
        `Refresh token for user ${stored.userId} rejected: version ${stored.tokenVersion} != ${stored.user.tokenVersion}`,
      );
      throw new UnauthorizedException('Refresh token revoked');
    }
    if (stored.expiresAt < new Date()) {
      await this.prisma.refreshToken.delete({ where: { id: stored.id } });
      throw new UnauthorizedException('Refresh token expired');
    }

    // Soft-consume (keep the row so a future replay is detectable as reuse).
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { consumedAt: new Date() },
    });

    return this.issueSession(
      {
        id: stored.user.id,
        email: stored.user.email,
        role: stored.user.role,
        tokenVersion: stored.user.tokenVersion,
      },
      { deviceId: opts?.deviceId ?? stored.deviceId },
    );
  }

  /** Revoke a single session (logout). */
  async revoke(rawRefresh: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { tokenHash: this.hash(rawRefresh) } });
  }

  async revokeAllForUser(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.db(tx).refreshToken.deleteMany({ where: { userId } });
  }

  /** Revoke every session bound to a device (per-device sign-out). */
  async revokeForDevice(deviceId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { deviceId } });
  }

  /**
   * Immediate single-token logout: blacklist one access token so it stops
   * validating from the next request on, while every other token keeps working.
   *
   * Stateless access tokens can't be "deleted", so we record the token's `jti`
   * in Redis under {@link RedisKeys.jwtBlacklist} and check it on every
   * authenticated request (see JwtStrategy.validate). The entry's TTL is the
   * token's own remaining lifetime, derived from the signed `exp` claim — never
   * a client-supplied timestamp — so Redis evicts it exactly when the token
   * would have expired anyway. No cron, no DB, no manual cleanup.
   *
   * If the token has already expired we do nothing: it is already rejected by
   * signature/`exp` verification, and writing a zero/negative TTL to Redis is
   * either a no-op or an error. Both `jti` and `exp` come from the verified
   * payload the JWT strategy produced, so they are trustworthy here.
   *
   * @param jti the access token's unique id (JwtPayload.jti)
   * @param exp the access token's expiry, seconds since epoch (JwtPayload.exp)
   */
  async blacklistAccessToken(jti: string | undefined, exp: number | undefined): Promise<void> {
    // Legacy tokens minted before `jti` existed carry nothing to blacklist;
    // they are already rejected by the tokenVersion check in JwtStrategy.
    if (!jti || !exp) return;
    const remainingSeconds = exp - Math.floor(Date.now() / 1000);
    if (remainingSeconds <= 0) return; // already expired — never store.
    await this.redis.setEx(RedisKeys.jwtBlacklist(jti), remainingSeconds, true);
  }

  /**
   * True if this access token's `jti` has been blacklisted (logout). Exactly one
   * Redis EXISTS lookup — no SCAN/KEYS, no DB. Called on every authenticated
   * request by JwtStrategy.
   */
  async isAccessTokenBlacklisted(jti: string | undefined): Promise<boolean> {
    if (!jti) return false;
    return this.redis.exists(RedisKeys.jwtBlacklist(jti));
  }

  /**
   * Kill every *access* token already issued for a user by atomically bumping
   * their session version. Access tokens are stateless, so this is the only way
   * to stop one before it expires: JwtStrategy compares the token's
   * `tokenVersion` claim against this column on every authenticated request.
   *
   * A low-level primitive — prefer {@link TokenService.revokeAllSessions},
   * which is the single revocation entry point and also clears refresh tokens
   * and notifies transports.
   *
   * @returns the new token version.
   */
  async incrementTokenVersion(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const user = await this.db(tx).appUser.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    this.logger.log(
      `Token version bumped for user ${userId} -> ${user.tokenVersion}`,
    );
    return user.tokenVersion;
  }

  /**
   * THE revocation entry point — every security-sensitive event goes through
   * here (logout-all-devices and phone-number change today; account recovery,
   * admin blocking and suspicious activity later), so the semantics can only
   * ever be changed in one place.
   *
   * Full sign-out everywhere:
   *   1. drop the refresh-token family, so no device can mint a fresh session;
   *   2. bump the session version, so the access tokens still in flight —
   *      including the caller's own — stop validating immediately, and any
   *      refresh row that races in behind step 1 is stamped stale (see
   *      {@link TokenService.rotate});
   *   3. notify transports holding a connection open across requests (live
   *      WebSockets), unless the caller owns the transaction — see below.
   *
   * Pass `tx` to enlist in the caller's transaction (e.g. phone change, where
   * the profile write and the revocation must commit together). Because the
   * writes are then not yet visible to other connections, the caller MUST call
   * {@link TokenService.notifySessionsRevoked} once the transaction commits —
   * firing it earlier would let a client reconnect against pre-commit state and
   * keep a socket that should have died.
   *
   * @returns the new token version.
   */
  async revokeAllSessions(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    await this.revokeAllForUser(userId, tx);
    const tokenVersion = await this.incrementTokenVersion(userId, tx);
    if (!tx) this.notifySessionsRevoked(userId);
    return tokenVersion;
  }

  /** Register a transport to be told when a user's sessions are revoked. */
  onSessionsRevoked(listener: SessionRevocationListener): void {
    this.revocationListeners.push(listener);
  }

  /**
   * Fire the revocation listeners. Called automatically by
   * {@link TokenService.revokeAllSessions}; call it manually only after
   * committing a transaction you passed into that method. A throwing listener
   * is logged and skipped — dropping a socket is best effort and must never
   * fail the revocation that already committed.
   */
  notifySessionsRevoked(userId: string): void {
    for (const listener of this.revocationListeners) {
      try {
        listener(userId);
      } catch (err) {
        this.logger.warn(
          `Session revocation listener failed for user ${userId}: ${String(err)}`,
        );
      }
    }
  }
}
