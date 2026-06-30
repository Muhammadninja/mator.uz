import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MyIdIdentity {
  pinfl: string;
  passportSerial?: string;
  passportNumber?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  dateOfBirth?: string; // ISO yyyy-mm-dd
  gender?: 'male' | 'female';
  citizenshipIso3?: string;
  addressRegion?: string;
  addressDistrict?: string;
  addressStreet?: string;
  biometricMatchScore?: number;
}

export interface AuthorizeUrlParams {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  uiLocale?: string;
}

export interface ExchangeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Abstraction over the myid.uz OAuth2 identity provider. */
export interface MyIdProvider {
  buildAuthorizeUrl(params: AuthorizeUrlParams): string;
  exchangeCode(params: ExchangeParams): Promise<MyIdIdentity>;
}

/**
 * Dev/local provider: builds a real-looking authorize URL and returns a
 * deterministic verified identity without calling myid.uz. Swap for the real
 * HTTP provider in production via MYID_PROVIDER=live.
 */
export class StubMyIdProvider implements MyIdProvider {
  private readonly logger = new Logger('StubMyIdProvider');
  private readonly authorizeBase: string;
  private readonly clientId: string;

  constructor(config: ConfigService) {
    this.authorizeBase =
      config.get<string>('MYID_AUTHORIZE_URL') ?? 'https://myid.uz/oauth2/authorize';
    this.clientId = config.get<string>('MYID_CLIENT_ID') ?? 'mator-dev';
  }

  buildAuthorizeUrl(p: AuthorizeUrlParams): string {
    const q = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: p.redirectUri,
      scope: p.scopes.join(' '),
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      ui_locales: p.uiLocale ?? 'uz',
    });
    return `${this.authorizeBase}?${q.toString()}`;
  }

  exchangeCode(p: ExchangeParams): Promise<MyIdIdentity> {
    this.logger.warn(`[MYID STUB] exchanging code ${p.code.slice(0, 8)}… — returning mock identity`);
    return Promise.resolve({
      pinfl: '30101950220011',
      passportSerial: 'AA',
      passportNumber: '1234567',
      firstName: 'Akmal',
      lastName: 'Karimov',
      middleName: 'Bekzodovich',
      dateOfBirth: '1995-01-01',
      gender: 'male',
      citizenshipIso3: 'UZB',
      addressRegion: 'Toshkent shahri',
      addressDistrict: 'Yunusobod tumani',
      addressStreet: "Amir Temur ko'chasi 12, kv. 45",
      biometricMatchScore: 0.973,
    });
  }
}
