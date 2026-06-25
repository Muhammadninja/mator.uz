import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtKeyService } from './jwt-key.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

export const ACCESS_TTL_SECONDS = 60 * 60; // 1h (matches the mobile contract)
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90d
const ISSUER = 'mator';

export interface SessionUser {
  id: string;
  email: string | null;
  role: string;
}

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
 *   • access  = RS256 JWT with a `kid` header (rotation/JWKS ready)
 *   • refresh = opaque random `rt_…`, stored only as a SHA-256 hash, rotated on
 *               every use with reuse detection (soft-consume via consumedAt).
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly keys: JwtKeyService,
    private readonly config: ConfigService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async signAccessToken(user: SessionUser): Promise<string> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
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
    // Already rotated once -> replay/theft. Revoke the whole family.
    if (stored.consumedAt) {
      await this.revokeAllForUser(stored.userId);
      this.logger.warn(`Refresh reuse detected for user ${stored.userId}; family revoked`);
      throw new UnauthorizedException('Refresh token reuse detected');
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
      { id: stored.user.id, email: stored.user.email, role: stored.user.role },
      { deviceId: opts?.deviceId ?? stored.deviceId },
    );
  }

  /** Revoke a single session (logout). */
  async revoke(rawRefresh: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { tokenHash: this.hash(rawRefresh) } });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
  }

  /** Revoke every session bound to a device (per-device sign-out). */
  async revokeForDevice(deviceId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { deviceId } });
  }
}
