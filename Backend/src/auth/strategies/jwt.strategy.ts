import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { JwtKeyService } from '../tokens/jwt-key.service';
import { TokenService } from '../tokens/token.service';

/**
 * Request fields the strategy stashes for the current access token, so the
 * logout handlers can blacklist exactly the token that authenticated the call
 * without re-parsing the Authorization header. Kept off `req.user` on purpose:
 * `req.user` is the response body of GET /v1/auth/me and must not change shape.
 */
export interface AuthenticatedTokenMeta {
  jti?: string;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    keys: JwtKeyService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // RS256: verify with the public key; tokens carry a `kid` header.
      secretOrKey: keys.publicKey,
      algorithms: ['RS256'],
      issuer: 'mator',
      audience: config.get<string>('JWT_AUDIENCE') ?? 'mator-app',
      // Hand the request to validate() so we can attach the token's jti/exp for
      // the logout handlers (see AuthenticatedTokenMeta).
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload) {
    // Single-token revocation (logout) is checked FIRST, before the DB read: a
    // blacklisted jti is rejected on one Redis EXISTS call without ever hitting
    // PostgreSQL. Rejected exactly like any other invalid JWT; the entry
    // self-expires with the token's TTL.
    if (await this.tokens.isAccessTokenBlacklisted(payload.jti)) {
      throw new UnauthorizedException('Token revoked');
    }
    const user = await this.prisma.appUser.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();
    // Session versioning — runs on EVERY authenticated request, not just login:
    // a bumped AppUser.tokenVersion (logout-all, and any future security event)
    // invalidates every access token signed with an older version, instantly.
    // Legacy tokens minted before this claim existed carry no version and are
    // therefore rejected too; clients recover silently via /v1/auth/refresh.
    if (payload.tokenVersion !== user.tokenVersion) {
      throw new UnauthorizedException('Token revoked');
    }
    // Expose the current token's identity for the logout handlers, without
    // touching req.user (the /me response body).
    (req as Request & { tokenMeta?: AuthenticatedTokenMeta }).tokenMeta = {
      jti: payload.jti,
      exp: payload.exp,
    };
    // tokenVersion is internal bookkeeping — drop it with the hash so `req.user`
    // (and therefore GET /v1/auth/me) keeps exactly the shape it had before.
    const { passwordHash: _, tokenVersion: __, ...safe } = user;
    return safe;
  }
}
