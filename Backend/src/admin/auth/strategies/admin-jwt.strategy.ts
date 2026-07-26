import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { AdminRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AdminAuthConfig,
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_ISSUER,
} from '../admin-auth.config';
import { AdminJwtPayload } from '../interfaces/admin-jwt-payload.interface';

/** Passport strategy name. Distinct from the mobile app's default `jwt`. */
export const ADMIN_JWT_STRATEGY = 'admin-jwt';

/**
 * The authenticated admin, as attached to `req.user` on admin routes. Contains
 * no secret material — never the password hash, never a token.
 */
export interface AuthenticatedAdmin {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** Current admin access token's identity, stashed for the logout handler. */
export interface AdminTokenMeta {
  jti?: string;
  exp?: number;
}

export type AdminRequest = Request & {
  user?: AuthenticatedAdmin;
  adminTokenMeta?: AdminTokenMeta;
};

/**
 * Verifies admin access tokens. Registered under its own strategy name, with
 * its own secret, algorithm and audience — a user token (RS256, `mator-app`)
 * fails signature verification here before any claim is even read, and an admin
 * token fails the same way inside the user's JwtStrategy.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(
  Strategy,
  ADMIN_JWT_STRATEGY,
) {
  constructor(
    private readonly prisma: PrismaService,
    config: AdminAuthConfig,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.secret,
      // Pinned: without this, a token signed with a different algorithm could be
      // presented against the same secret.
      algorithms: ['HS256'],
      issuer: ADMIN_JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
      passReqToCallback: true,
    });
  }

  async validate(
    req: Request,
    payload: AdminJwtPayload,
  ): Promise<AuthenticatedAdmin> {
    // Defence in depth: the signature/audience checks above already make a user
    // token unverifiable here, but a token missing the admin discriminator is
    // rejected outright rather than trusted by omission.
    if (payload.type !== 'admin') {
      throw new UnauthorizedException('Not an admin token');
    }

    const admin = await this.prisma.appAdmin.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        tokenVersion: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!admin) throw new UnauthorizedException();

    // Deactivation takes effect on the NEXT request, not when the token expires.
    if (!admin.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }
    // Session versioning — runs on EVERY authenticated request: a bumped
    // AppAdmin.tokenVersion (logout-all, password change, refresh reuse)
    // invalidates every access token signed with an older version, instantly.
    if (payload.tokenVersion !== admin.tokenVersion) {
      throw new UnauthorizedException('Token revoked');
    }

    (req as AdminRequest).adminTokenMeta = {
      jti: payload.jti,
      exp: payload.exp,
    };

    // Built field by field rather than by spreading `admin`: req.user IS the
    // GET /v1/auth/admin/me response body, so the exposed shape is stated
    // explicitly here and a column added to AppAdmin later (tokenVersion, or any
    // future secret) cannot leak into it by default.
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      isActive: admin.isActive,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    };
  }
}
