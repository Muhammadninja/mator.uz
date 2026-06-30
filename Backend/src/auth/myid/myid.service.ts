import {
  Injectable,
  BadRequestException,
  GoneException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'crypto';
import { AuthProvider, Gender } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { StubMyIdProvider, MyIdProvider, MyIdIdentity } from './myid-provider';
import { MyIdInitiateDto } from './dto/myid-initiate.dto';
import { MyIdCallbackDto } from './dto/myid-callback.dto';

const DEFAULT_SCOPES = ['passport_data', 'pinfl', 'address', 'biometric_verdict'];
const SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT_UZS = 50_000_000;

@Injectable()
export class MyIdService {
  private readonly provider: MyIdProvider;
  private readonly verifiedLimitUzs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // Swap for a live HTTP provider via MYID_PROVIDER=live in production.
    this.provider = new StubMyIdProvider(config);
    this.verifiedLimitUzs = Number(config.get<string>('MYID_VERIFIED_LIMIT_UZS')) || DEFAULT_LIMIT_UZS;
  }

  async initiate(userId: string, dto: MyIdInitiateDto) {
    const scopes = dto.scopes?.length ? dto.scopes : DEFAULT_SCOPES;

    // PKCE: use the client's challenge if provided, otherwise generate our own.
    let codeChallenge = dto.code_challenge;
    let codeVerifier: string | null = null;
    if (!codeChallenge) {
      codeVerifier = randomBytes(32).toString('base64url');
      codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    }

    const state = `state_${randomBytes(16).toString('hex')}`;
    const sessionId = prefixedId(IdPrefix.MYID_SESSION);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.prisma.myIdSession.create({
      data: {
        id: sessionId,
        userId,
        state,
        codeChallenge,
        codeVerifier,
        redirectUri: dto.redirect_uri,
        scopes,
        status: 'pending',
        expiresAt,
      },
    });
    await this.prisma.appUser.update({
      where: { id: userId },
      data: { myIdStatus: 'PENDING' },
    });

    const authorizeUrl = this.provider.buildAuthorizeUrl({
      state,
      codeChallenge,
      redirectUri: dto.redirect_uri,
      scopes,
      uiLocale: dto.ui_locale,
    });

    return {
      session_id: sessionId,
      authorize_url: authorizeUrl,
      expires_at: expiresAt.toISOString(),
    };
  }

  async callback(userId: string, dto: MyIdCallbackDto) {
    const session = await this.prisma.myIdSession.findUnique({ where: { id: dto.session_id } });
    if (!session || session.userId !== userId || session.state !== dto.state) {
      throw new BadRequestException('Invalid MyID session');
    }
    if (session.expiresAt < new Date()) {
      throw new GoneException('MyID session expired');
    }

    const codeVerifier = dto.code_verifier ?? session.codeVerifier;
    if (!codeVerifier) {
      throw new BadRequestException('Missing PKCE code_verifier');
    }

    const identity = await this.provider.exchangeCode({
      code: dto.code,
      codeVerifier,
      redirectUri: session.redirectUri,
    });

    // Enforce one national identity -> one account.
    const existingIdentity = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerUserId: { provider: AuthProvider.MYID, providerUserId: identity.pinfl },
      },
    });
    if (existingIdentity && existingIdentity.userId !== userId) {
      throw new ConflictException('This identity is already linked to another account');
    }

    const verificationId = prefixedId(IdPrefix.MYID_VERIFICATION);
    const verifiedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.myIdVerification.create({
        data: {
          id: verificationId,
          userId,
          sessionId: session.id,
          status: 'verified',
          pinfl: identity.pinfl,
          passportSerial: identity.passportSerial,
          passportNumber: identity.passportNumber,
          firstName: identity.firstName,
          lastName: identity.lastName,
          middleName: identity.middleName,
          dateOfBirth: identity.dateOfBirth ? new Date(identity.dateOfBirth) : null,
          gender: this.mapGender(identity.gender),
          citizenshipIso3: identity.citizenshipIso3,
          addressRegion: identity.addressRegion,
          addressDistrict: identity.addressDistrict,
          addressStreet: identity.addressStreet,
          biometricMatchScore: identity.biometricMatchScore,
          verifiedAt,
        },
      });

      if (!existingIdentity) {
        await tx.authIdentity.create({
          data: { provider: AuthProvider.MYID, providerUserId: identity.pinfl, userId },
        });
      }

      await tx.myIdSession.update({ where: { id: session.id }, data: { status: 'verified' } });
      await tx.appUser.update({
        where: { id: userId },
        data: {
          myIdStatus: 'VERIFIED',
          transactionLimitUzs: this.verifiedLimitUzs,
          firstName: identity.firstName ?? undefined,
          lastName: identity.lastName ?? undefined,
        },
      });
    });

    return {
      verification_id: verificationId,
      status: 'verified',
      verified_at: verifiedAt.toISOString(),
      identity: this.presentIdentity(identity),
      transaction_limit_uzs: this.verifiedLimitUzs,
      next_screen: 'GarageListScreen',
    };
  }

  async status(userId: string, sessionId: string) {
    const session = await this.prisma.myIdSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new NotFoundException('MyID session not found');
    }
    return { session_id: sessionId, state: session.status, polling_interval_ms: 2000 };
  }

  private mapGender(g?: 'male' | 'female'): Gender | null {
    if (g === 'male') return Gender.MALE;
    if (g === 'female') return Gender.FEMALE;
    return null;
  }

  private presentIdentity(i: MyIdIdentity) {
    return {
      pinfl: i.pinfl,
      passport_serial: i.passportSerial,
      passport_number: i.passportNumber,
      first_name: i.firstName,
      last_name: i.lastName,
      middle_name: i.middleName,
      date_of_birth: i.dateOfBirth,
      gender: i.gender,
      citizenship_iso3: i.citizenshipIso3,
      address_region: i.addressRegion,
      address_district: i.addressDistrict,
      address_street: i.addressStreet,
      biometric_match_score: i.biometricMatchScore,
    };
  }
}
