import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage } from 'http';
import { JwtKeyService } from '../auth/tokens/jwt-key.service';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';

/**
 * Authenticates a WebSocket upgrade by verifying the access token the same way
 * the HTTP JwtStrategy does (RS256, issuer `mator`, audience). The token is
 * taken from the `Authorization: Bearer` header first (preferred: query strings
 * are logged by proxies/Nginx and end up in access logs), falling back to the
 * `token` query param for clients that cannot set headers on the WS handshake.
 */
@Injectable()
export class WsAuthService {
  private readonly audience: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly keys: JwtKeyService,
    config: ConfigService,
  ) {
    this.audience = config.get<string>('JWT_AUDIENCE') ?? 'mator-app';
  }

  /** Returns the authenticated user id, or throws UnauthorizedException. */
  async authenticate(request: IncomingMessage): Promise<string> {
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Missing token');
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        algorithms: ['RS256'],
        publicKey: this.keys.publicKey,
        issuer: 'mator',
        audience: this.audience,
      });
      if (!payload.sub) throw new UnauthorizedException();
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  private extractToken(request: IncomingMessage): string | null {
    // Prefer the Authorization header — when both are present, it wins. The
    // header keeps the token out of URLs (and therefore out of proxy/access
    // logs), which the query param cannot avoid.
    const header = request.headers['authorization'];
    if (header?.startsWith('Bearer ')) return header.slice(7);

    // TODO(api-v2): query-token support is a temporary fallback for clients
    // that cannot set headers on the WS handshake. Remove it in a future API
    // version once all clients send the Authorization header.
    const url = new URL(request.url ?? '', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;

    return null;
  }
}
