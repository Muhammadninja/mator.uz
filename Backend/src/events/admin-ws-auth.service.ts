import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminRole } from '@prisma/client';
import type { IncomingMessage } from 'http';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminAuthConfig,
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_ISSUER,
} from '../admin/auth/admin-auth.config';
import { AdminJwtPayload } from '../admin/auth/interfaces/admin-jwt-payload.interface';
import { AdminTokenService } from '../admin/auth/admin-token.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis.keys';
import { extractWsToken } from '../common/ws-handshake.util';

export interface AuthenticatedAdmin {
  adminId: string;
  role: AdminRole;
  tokenVersion: number;
  jti?: string;
  sid?: string;
  /** Expiry of the access token, seconds since epoch. */
  exp?: number;
}

/**
 * Authenticates a WebSocket upgrade for the admin realtime channel the same way
 * the HTTP AdminJwtStrategy does: HS256 with ADMIN_JWT_SECRET, issuer
 * `mator-admin`, audience `mator-admin-panel`, `type: "admin"`, the logout and
 * device-revocation markers, an active account, and a session version that
 * still matches AppAdmin.tokenVersion. Kept entirely separate from the user-side
 * WsAuthService (RS256 / `mator`) so neither identity space can open the
 * other's channel.
 *
 * The token is read from `Authorization: Bearer` or the bearer subprotocol only.
 * A `?token=` query parameter is not accepted: it would put an admin credential
 * into proxy access logs, and no client of this channel needs it.
 */
@Injectable()
export class AdminWsAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AdminAuthConfig,
    private readonly tokens: AdminTokenService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Returns the authenticated admin, or throws UnauthorizedException. A Redis
   * or database failure propagates as itself and is never read as success.
   */
  async authenticate(request: IncomingMessage): Promise<AuthenticatedAdmin> {
    const token = extractWsToken(request, false);
    if (!token) throw new UnauthorizedException('Missing token');

    let payload: AdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, {
        algorithms: ['HS256'],
        secret: this.config.secret,
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    if (payload.type !== 'admin' || !payload.sub) {
      throw new UnauthorizedException('Invalid token');
    }

    if (await this.tokens.isAccessTokenRevoked(payload)) {
      throw new UnauthorizedException('Token revoked');
    }
    const admin = await this.prisma.appAdmin.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true, isActive: true, role: true },
    });
    if (
      !admin ||
      !admin.isActive ||
      payload.tokenVersion !== admin.tokenVersion
    ) {
      throw new UnauthorizedException('Token revoked');
    }
    return {
      adminId: payload.sub,
      role: admin.role,
      tokenVersion: admin.tokenVersion,
      jti: payload.jti,
      sid: payload.sid,
      exp: payload.exp,
    };
  }

  /**
   * Re-check open admin sockets in one database query and one Redis round trip.
   * Returns, per session and in order, whether it may stay open. Rejects when
   * either store cannot answer.
   */
  async stillValid(sessions: AuthenticatedAdmin[]): Promise<boolean[]> {
    if (sessions.length === 0) return [];
    const ids = [...new Set(sessions.map((s) => s.adminId))];
    const [admins, marks] = await Promise.all([
      this.prisma.appAdmin.findMany({
        where: { id: { in: ids } },
        select: { id: true, tokenVersion: true, isActive: true },
      }),
      this.redis.existsEach(
        sessions.flatMap((s) => [
          RedisKeys.adminJwtBlacklist(s.jti ?? '-'),
          RedisKeys.adminSessionRevoked(s.sid ?? '-'),
        ]),
      ),
    ]);
    const byId = new Map(admins.map((a) => [a.id, a]));
    return sessions.map((s, i) => {
      const admin = byId.get(s.adminId);
      return (
        !!admin &&
        admin.isActive &&
        admin.tokenVersion === s.tokenVersion &&
        !(s.jti && marks[i * 2]) &&
        !(s.sid && marks[i * 2 + 1])
      );
    });
  }
}
