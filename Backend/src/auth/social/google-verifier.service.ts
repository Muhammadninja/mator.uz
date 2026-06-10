import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { AuthProvider } from '@prisma/client';
import { SocialProfile } from './social-profile.interface';
import { normalizeEmail } from '../email.util';

@Injectable()
export class GoogleVerifierService {
  private readonly logger = new Logger(GoogleVerifierService.name);
  private readonly client = new OAuth2Client();
  private readonly audiences: string[];

  constructor(private readonly config: ConfigService) {
    // Comma-separated list of every OAuth client ID that may mint ID tokens
    // for this backend (iOS client, Android client, web client).
    this.audiences = (this.config.get<string>('GOOGLE_CLIENT_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  async verify(idToken: string): Promise<SocialProfile> {
    if (this.audiences.length === 0) {
      this.logger.error('GOOGLE_CLIENT_IDS is not configured');
      throw new UnauthorizedException('Google sign-in is not available');
    }

    let ticket;
    try {
      ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audiences,
      });
    } catch (err) {
      this.logger.warn(`Google token verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid Google token');
    }

    const payload = ticket.getPayload();
    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid Google token');
    }

    // verifyIdToken already checks signature, audience, issuer and expiry.
    if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
      throw new UnauthorizedException('Invalid Google token issuer');
    }

    return {
      provider: AuthProvider.GOOGLE,
      providerUserId: payload.sub,
      email: payload.email ? normalizeEmail(payload.email) : null,
      emailVerified: payload.email_verified === true,
      firstName: payload.given_name ?? null,
      lastName: payload.family_name ?? null,
    };
  }
}
