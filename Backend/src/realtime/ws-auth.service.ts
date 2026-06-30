import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage } from 'http';
import { JwtKeyService } from '../auth/tokens/jwt-key.service';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';

/**
 * Authenticates a WebSocket upgrade by verifying the access token the same way
 * the HTTP JwtStrategy does (RS256, issuer `mator`, audience). Browsers cannot
 * set headers on a WS handshake, so the token is taken from the `token` query
 * param first, falling back to an `Authorization: Bearer` header.
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
    const url = new URL(request.url ?? '', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;
    const header = request.headers['authorization'];
    if (header?.startsWith('Bearer ')) return header.slice(7);
    return null;
  }
}
