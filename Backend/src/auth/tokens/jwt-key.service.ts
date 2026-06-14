import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'crypto';

/**
 * Provides the RS256 key material used to sign and verify access tokens.
 *
 * Production: supply PEM keys via env (JWT_PRIVATE_KEY / JWT_PUBLIC_KEY) and a
 * stable JWT_KID so tokens survive restarts and other services can verify them
 * against the published public key (JWKS).
 *
 * Dev fallback: if keys are absent, an ephemeral RSA pair is generated at boot
 * (tokens then become invalid after a restart — acceptable for local dev).
 */
@Injectable()
export class JwtKeyService {
  private readonly logger = new Logger(JwtKeyService.name);
  private _privateKey!: string;
  private _publicKey!: string;
  private _kid!: string;

  // Initialized in the constructor (not onModuleInit) so the keys are ready
  // when JwtStrategy reads the public key during its own construction.
  constructor(private readonly config: ConfigService) {
    const priv = this.normalizePem(this.config.get<string>('JWT_PRIVATE_KEY'));
    const pub = this.normalizePem(this.config.get<string>('JWT_PUBLIC_KEY'));
    const kid = this.config.get<string>('JWT_KID');

    if (priv && pub && kid) {
      this._privateKey = priv;
      this._publicKey = pub;
      this._kid = kid;
      return;
    }

    this.logger.warn(
      'JWT RS256 keys not fully configured — generating an EPHEMERAL dev keypair. ' +
        'Set JWT_PRIVATE_KEY, JWT_PUBLIC_KEY and JWT_KID for production.',
    );
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    this._privateKey = privateKey;
    this._publicKey = publicKey;
    this._kid = `dev-${Date.now()}`;
  }

  // Env vars often store PEM newlines as literal "\n".
  private normalizePem(value?: string): string | undefined {
    return value ? value.replace(/\\n/g, '\n') : undefined;
  }

  get privateKey(): string {
    return this._privateKey;
  }

  get publicKey(): string {
    return this._publicKey;
  }

  get kid(): string {
    return this._kid;
  }
}
