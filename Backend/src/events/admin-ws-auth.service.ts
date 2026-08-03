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

export interface AuthenticatedAdmin {
  adminId: string;
  role: AdminRole;
}

/**
 * Authenticates a WebSocket upgrade for the admin realtime channel the same way
 * the HTTP AdminJwtStrategy does: HS256 with ADMIN_JWT_SECRET, issuer
 * `mator-admin`, audience `mator-admin-panel`, `type: "admin"`, and a session
 * version that must still match AppAdmin.tokenVersion. Kept entirely separate
 * from the user-side WsAuthService (RS256 / `mator`) so neither identity space
 * can open the other's channel.
 */
@Injectable()
export class AdminWsAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AdminAuthConfig,
  ) {}

  /** Returns the authenticated admin, or throws UnauthorizedException. */
  async authenticate(request: IncomingMessage): Promise<AuthenticatedAdmin> {
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Missing token');

    let payload: AdminJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminJwtPayload>(token, {
        algorithms: ['HS256'],
        secret: this.config.secret,
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
      });
      if (payload.type !== 'admin' || !payload.sub) {
        throw new UnauthorizedException();
      }
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    // Same revocation check the HTTP AdminJwtStrategy runs: a bumped session
    // version (logout-all, deactivation, password change, refresh reuse) must
    // also close any realtime channel the token opened.
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
    return { adminId: payload.sub, role: admin.role };
  }

  private extractToken(request: IncomingMessage): string | null {
    // Prefer the Authorization header — keeps the token out of URLs (and proxy
    // access logs). Fall back to the `token` query param for clients that
    // cannot set headers on the WS handshake.
    const header = request.headers['authorization'];
    if (header?.startsWith('Bearer ')) return header.slice(7);

    const url = new URL(request.url ?? '', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    return queryToken ?? null;
  }
}
