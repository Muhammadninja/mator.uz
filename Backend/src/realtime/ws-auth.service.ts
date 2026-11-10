import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage } from 'http';
import { PrismaService } from '../prisma/prisma.service';
import { JwtKeyService } from '../auth/tokens/jwt-key.service';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { TokenService } from '../auth/tokens/token.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis.keys';
import { extractWsToken } from '../common/ws-handshake.util';

/** The access token a realtime socket was opened with. */
export interface WsSession {
  userId: string;
  tokenVersion: number;
  jti?: string;
  /** Expiry of the access token, seconds since epoch. */
  exp?: number;
}

/**
 * Whether `?token=` is still read on the buyer handshake. App builds released
 * before the bearer subprotocol can only send the token that way, so it stays on
 * until they are gone; set REALTIME_QUERY_TOKEN_ENABLED=false to refuse it.
 */
export function realtimeQueryTokenEnabled(raw: string | undefined): boolean {
  return (raw ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * Authenticates a WebSocket upgrade exactly as the HTTP JwtStrategy does: RS256,
 * issuer `mator`, audience, the jti blacklist (logout), a live account, and the
 * session version. The token arrives in `Authorization: Bearer` or the bearer
 * subprotocol (see ws-handshake.util.ts).
 */
@Injectable()
export class WsAuthService {
  private readonly audience: string;
  private readonly allowQueryToken: boolean;

  constructor(
    private readonly jwt: JwtService,
    private readonly keys: JwtKeyService,
    private readonly prisma: PrismaService,
    config: ConfigService,
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
  ) {
    this.audience = config.get<string>('JWT_AUDIENCE') ?? 'mator-app';
    this.allowQueryToken = realtimeQueryTokenEnabled(
      config.get<string>('REALTIME_QUERY_TOKEN_ENABLED'),
    );
  }

  /**
   * Returns the session, or throws UnauthorizedException. A Redis or database
   * failure propagates as itself: the caller refuses the socket as "try again",
   * never as authenticated.
   */
  async authenticate(request: IncomingMessage): Promise<WsSession> {
    const token = extractWsToken(request, this.allowQueryToken);
    if (!token) throw new UnauthorizedException('Missing token');
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        algorithms: ['RS256'],
        publicKey: this.keys.publicKey,
        issuer: 'mator',
        audience: this.audience,
      });
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    if (!payload.sub) throw new UnauthorizedException('Invalid token');

    if (await this.tokens.isAccessTokenBlacklisted(payload.jti)) {
      throw new UnauthorizedException('Token revoked');
    }
    const user = await this.prisma.appUser.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true, deletedAt: true },
    });
    if (
      !user ||
      user.deletedAt ||
      payload.tokenVersion !== user.tokenVersion
    ) {
      throw new UnauthorizedException('Token revoked');
    }
    return {
      userId: payload.sub,
      tokenVersion: user.tokenVersion,
      jti: payload.jti,
      exp: payload.exp,
    };
  }

  /**
   * Re-check open sockets in one database query and one Redis round trip,
   * however many there are. Returns, per session and in order, whether it may
   * stay open. Rejects when either store cannot answer.
   */
  async stillValid(sessions: WsSession[]): Promise<boolean[]> {
    if (sessions.length === 0) return [];
    const ids = [...new Set(sessions.map((s) => s.userId))];
    const [users, blacklisted] = await Promise.all([
      this.prisma.appUser.findMany({
        where: { id: { in: ids } },
        select: { id: true, tokenVersion: true, deletedAt: true },
      }),
      this.redis.existsEach(
        sessions.map((s) => RedisKeys.jwtBlacklist(s.jti ?? '-')),
      ),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    return sessions.map((s, i) => {
      const user = byId.get(s.userId);
      return (
        !!user &&
        !user.deletedAt &&
        user.tokenVersion === s.tokenVersion &&
        !(s.jti && blacklisted[i])
      );
    });
  }
}
