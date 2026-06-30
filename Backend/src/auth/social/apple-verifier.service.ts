import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthProvider } from '@prisma/client';
import { SocialProfile } from './social-profile.interface';
import { normalizeEmail } from '../email.util';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

interface AppleNameHint {
  firstName?: string;
  lastName?: string;
}

interface AppleIdTokenClaims extends JWTPayload {
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
}

@Injectable()
export class AppleVerifierService {
  private readonly logger = new Logger(AppleVerifierService.name);
  // Cached, auto-rotating remote key set — Apple rotates its signing keys.
  private readonly jwks = createRemoteJWKSet(APPLE_JWKS_URL);
  private readonly audiences: string[];

  constructor(private readonly config: ConfigService) {
    // Your app's bundle ID(s) / Services ID. Comma-separated.
    this.audiences = (this.config.get<string>('APPLE_CLIENT_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  /**
   * Apple only returns the user's name on the FIRST authorization, in the
   * request body (never inside the identity token). `nameHint` carries it.
   */
  async verify(identityToken: string, nameHint?: AppleNameHint): Promise<SocialProfile> {
    if (this.audiences.length === 0) {
      this.logger.error('APPLE_CLIENT_IDS is not configured');
      throw new UnauthorizedException('Apple sign-in is not available');
    }

    let claims: AppleIdTokenClaims;
    try {
      const { payload } = await jwtVerify(identityToken, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: this.audiences,
      });
      claims = payload as AppleIdTokenClaims;
    } catch (err) {
      this.logger.warn(`Apple token verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid Apple token');
    }

    if (!claims.sub) {
      throw new UnauthorizedException('Invalid Apple token');
    }

    // Apple encodes email_verified as boolean or the string "true".
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';

    return {
      provider: AuthProvider.APPLE,
      providerUserId: claims.sub,
      email: claims.email ? normalizeEmail(claims.email) : null,
      emailVerified,
      firstName: nameHint?.firstName ?? null,
      lastName: nameHint?.lastName ?? null,
    };
  }
}
