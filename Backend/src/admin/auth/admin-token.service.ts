import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuthConfig,
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_ISSUER,
} from './admin-auth.config';
import { AdminJwtPayload } from './interfaces/admin-jwt-payload.interface';

export interface AdminSessionSubject {
  id: string;
  role: AdminRole;
  tokenVersion: number;
}

/**
 * Where a session was opened from, recorded so an admin can review and revoke
 * their devices individually.
 *
 * ALL THREE FIELDS ARE UNTRUSTED: `deviceName` and `userAgent` are whatever the
 * client sent, and `ip` can be shaped by proxies. They are display-only — no
 * authorization decision may ever read them. Values are truncated to the column
 * widths on write, so an oversized header cannot fail a login.
 */
export interface AdminSessionContext {
  deviceName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedAdminSession {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds — the `expiresIn` of the API contract. */
  expiresIn: number;
}

/**
 * Clamp untrusted metadata to its column width. Returns null for empty/absent
 * input so "not provided" and "provided as blank" collapse to one representation.
 */
function truncate(
  value: string | null | undefined,
  max: number,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Token issuance for the admin panel — the admin-side counterpart of
 * TokenService, intentionally kept as a separate implementation rather than a
 * shared one, because the two identity spaces must not be able to drift into
 * accepting each other's credentials:
 *
 *   • access  = HS256 JWT signed with ADMIN_JWT_SECRET, issuer/audience
 *               `mator-admin`/`mator-admin-panel`, carrying `type: "admin"` and
 *               the account's session version.
 *   • refresh = opaque random `art_…`, stored ONLY as a SHA-256 hash, rotated on
 *               every use with reuse detection (soft-consume via consumedAt) and
 *               bound to the session version, so a revoked family can never
 *               rotate its way back to a valid session.
 *
 * Nothing here reads or writes app_users / refresh_tokens.
 */
@Injectable()
export class AdminTokenService {
  private readonly logger = new Logger(AdminTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AdminAuthConfig,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async signAccessToken(admin: AdminSessionSubject): Promise<string> {
    const payload: AdminJwtPayload = {
      sub: admin.id,
      role: admin.role,
      type: 'admin',
      tokenVersion: admin.tokenVersion,
      jti: randomUUID(),
    };
    return this.jwt.signAsync(payload, {
      algorithm: 'HS256',
      secret: this.config.secret,
      expiresIn: this.config.accessTtlSeconds,
      issuer: ADMIN_JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
    });
  }

  /**
   * Issue a fresh admin access + opaque refresh pair.
   *
   * Every call INSERTS a new row, so logging in from another device opens an
   * additional independent session rather than displacing the existing ones.
   */
  async issueSession(
    admin: AdminSessionSubject,
    context: AdminSessionContext = {},
  ): Promise<IssuedAdminSession> {
    const accessToken = await this.signAccessToken(admin);
    const rawRefresh = `art_${randomBytes(32).toString('base64url')}`;

    await this.prisma.adminRefreshToken.create({
      data: {
        tokenHash: this.hash(rawRefresh),
        adminId: admin.id,
        // Bind the row to the version it was minted under, so a revocation that
        // lands between reading the account and writing this row leaves the row
        // provably stale instead of silently valid.
        tokenVersion: admin.tokenVersion,
        expiresAt: new Date(Date.now() + this.config.refreshTtlSeconds * 1000),
        // Untrusted, display-only provenance — truncated so a hostile header
        // cannot overflow the column and fail an otherwise valid login.
        deviceName: truncate(context.deviceName, 120),
        ip: truncate(context.ip, 45),
        userAgent: truncate(context.userAgent, 400),
        lastUsedAt: new Date(),
      },
    });

    return {
      accessToken,
      refreshToken: rawRefresh,
      expiresIn: this.config.accessTtlSeconds,
    };
  }

  /**
   * Rotate: validate the presented refresh token and issue a new pair. The old
   * token is invalid from this point on — it is soft-consumed, so presenting it
   * again is detected as reuse rather than merely "unknown".
   */
  async rotate(rawRefresh: string): Promise<IssuedAdminSession> {
    const stored = await this.prisma.adminRefreshToken.findUnique({
      where: { tokenHash: this.hash(rawRefresh) },
      include: { admin: true },
    });

    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Already rotated once -> replay/theft. A replayed refresh token means the
    // credential is in someone else's hands, so treat it as a full compromise:
    // revoke the whole family AND bump the session version, which also kills the
    // access tokens already in flight instead of leaving them valid for their
    // remaining TTL.
    if (stored.consumedAt) {
      await this.revokeAllSessions(stored.adminId);
      this.logger.warn(
        `Admin refresh reuse detected for admin ${stored.adminId}; all sessions revoked`,
      );
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    // Deliberately revoked (logout, or "sign out this device"). Distinct from
    // the reuse branch above: this token was never rotated, so presenting it is
    // a stale client, not evidence of theft — kill THIS session only and leave
    // the admin's other devices signed in.
    if (stored.revokedAt) {
      throw new UnauthorizedException('Refresh token revoked');
    }
    // Revoked family: the account's session version moved on since this row was
    // minted (logout-all, deactivation, password change, or a rotation that
    // raced a revocation).
    if (stored.tokenVersion !== stored.admin.tokenVersion) {
      await this.prisma.adminRefreshToken.delete({ where: { id: stored.id } });
      this.logger.warn(
        `Admin refresh token for ${stored.adminId} rejected: version ${stored.tokenVersion} != ${stored.admin.tokenVersion}`,
      );
      throw new UnauthorizedException('Refresh token revoked');
    }
    if (stored.expiresAt < new Date()) {
      await this.prisma.adminRefreshToken.delete({ where: { id: stored.id } });
      throw new UnauthorizedException('Refresh token expired');
    }
    // A deactivated admin must not be able to refresh their way into a live
    // session — the access token check alone would let them keep going until it
    // expires.
    if (!stored.admin.isActive) {
      await this.revokeAllSessions(stored.adminId);
      throw new UnauthorizedException('Account is deactivated');
    }

    // Soft-consume (keep the row so a future replay is detectable as reuse).
    // Conditional on consumedAt AND revokedAt still being null so neither two
    // concurrent rotations nor a rotation racing a "sign out this device" can
    // both proceed: the loser updates 0 rows and is rejected.
    const claimed = await this.prisma.adminRefreshToken.updateMany({
      where: { id: stored.id, consumedAt: null, revokedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.revokeAllSessions(stored.adminId);
      this.logger.warn(
        `Concurrent admin refresh rotation for admin ${stored.adminId}; all sessions revoked`,
      );
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    // Carry the session's provenance onto the successor row, so rotation does
    // not erase which device this session belongs to. `lastUsedAt` is refreshed
    // by issueSession, giving the sessions list a meaningful "last active".
    return this.issueSession(
      {
        id: stored.admin.id,
        role: stored.admin.role,
        tokenVersion: stored.admin.tokenVersion,
      },
      {
        deviceName: stored.deviceName,
        ip: stored.ip,
        userAgent: stored.userAgent,
      },
    );
  }

  /**
   * Revoke a single session (logout). Marks the row revoked instead of deleting
   * it, so the session stays visible in history and a later replay is still
   * recognisable. A deliberate logout is not a theft signal, so ONLY this
   * session dies — the admin's other devices stay signed in.
   */
  async revoke(rawRefresh: string): Promise<void> {
    await this.prisma.adminRefreshToken.updateMany({
      where: { tokenHash: this.hash(rawRefresh), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * The admin's live sessions, newest first — one entry per device.
   *
   * "Live" means: not rotated away (consumedAt null — a consumed row has already
   * been replaced by its successor), not revoked, not expired, and still on the
   * current session version. Never returns tokenHash: the list is for display,
   * and the hash is the credential's only stored form.
   */
  async listSessions(adminId: string) {
    const admin = await this.prisma.appAdmin.findUnique({
      where: { id: adminId },
      select: { tokenVersion: true },
    });
    if (!admin) return [];

    return this.prisma.adminRefreshToken.findMany({
      where: {
        adminId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        tokenVersion: admin.tokenVersion,
      },
      select: {
        id: true,
        deviceName: true,
        ip: true,
        userAgent: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  /**
   * Revoke ONE session by its id ("sign out this device"), leaving the others
   * alone. Scoped to `adminId` so an admin can only ever end their own sessions
   * — an id from another account matches nothing rather than revoking it.
   *
   * @returns true if a live session was revoked.
   */
  async revokeSession(adminId: string, sessionId: number): Promise<boolean> {
    const result = await this.prisma.adminRefreshToken.updateMany({
      where: { id: sessionId, adminId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Full sign-out everywhere: drop the refresh-token family and bump the session
   * version, so access tokens still in flight stop validating on their next
   * request (AdminJwtStrategy compares the claim against this column).
   *
   * @returns the new token version.
   */
  async revokeAllSessions(adminId: string): Promise<number> {
    await this.prisma.adminRefreshToken.deleteMany({ where: { adminId } });
    const admin = await this.prisma.appAdmin.update({
      where: { id: adminId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    this.logger.log(
      `Admin token version bumped for ${adminId} -> ${admin.tokenVersion}`,
    );
    return admin.tokenVersion;
  }
}
