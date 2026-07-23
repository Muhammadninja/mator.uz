import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { AppleLoginDto } from './dto/apple-login.dto';
import { Role } from '@prisma/client';
import { GoogleVerifierService } from './social/google-verifier.service';
import { AppleVerifierService } from './social/apple-verifier.service';
import { SocialIdentityService } from './social/social-identity.service';
import { EmailVerificationService } from './email-verification/email-verification.service';
import { TokenService } from './tokens/token.service';
import { hashPassword, verifyPassword, needsRehash } from './password.util';
import { normalizeEmail } from './email.util';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly googleVerifier: GoogleVerifierService,
    private readonly appleVerifier: AppleVerifierService,
    private readonly socialIdentity: SocialIdentityService,
    private readonly emailVerification: EmailVerificationService,
    private readonly tokens: TokenService,
  ) {}

  // Existing email/Google/Apple endpoints keep their {accessToken, refreshToken}
  // shape, but tokens are now issued by the unified TokenService (RS256 access +
  // opaque rotating refresh).
  private async generateTokens(
    userId: string,
    email: string | null,
    role: string,
    tokenVersion: number,
  ) {
    const session = await this.tokens.issueSession({ id: userId, email, role, tokenVersion });
    return { accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  private strip(user: { passwordHash: string | null; [key: string]: unknown }) {
    const { passwordHash: _, ...safe } = user;
    return safe;
  }

  async googleLogin(dto: GoogleLoginDto) {
    const profile = await this.googleVerifier.verify(dto.idToken);
    const user = await this.socialIdentity.resolveUser(profile);
    const tokens = await this.generateTokens(user.id, user.email, user.role, user.tokenVersion);
    return { user: this.strip(user), ...tokens };
  }

  async appleLogin(dto: AppleLoginDto) {
    const profile = await this.appleVerifier.verify(dto.identityToken, {
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
    const user = await this.socialIdentity.resolveUser(profile);
    const tokens = await this.generateTokens(user.id, user.email, user.role, user.tokenVersion);
    return { user: this.strip(user), ...tokens };
  }

  async register(dto: RegisterDto) {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.appUser.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    const passwordHash = await hashPassword(dto.password);
    const user = await this.prisma.appUser.create({
      data: {
        email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: Role.USER,
        emailVerified: false,
      },
    });

    // Variant A: NO tokens are issued at registration. The user must verify
    // their email before they can log in.
    await this.emailVerification.issueAndSend(user);
    return {
      message: 'Registration successful. Please check your email to verify your account.',
      email: user.email,
      emailVerified: false,
    };
  }

  async login(dto: LoginDto) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.appUser.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    // Social-only accounts have no password set.
    if (!user.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await verifyPassword(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    // Variant A: block password logins until the email is verified.
    if (!user.emailVerified) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before logging in.',
      });
    }

    // Transparently upgrade legacy bcrypt hashes to Argon2 on successful login.
    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(dto.password);
      await this.prisma.appUser.update({
        where: { id: user.id },
        data: { passwordHash: upgraded },
      });
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role, user.tokenVersion);
    return { user: this.strip(user), ...tokens };
  }

  /**
   * Verify the token and resolve a redirect URL. Never throws — email links
   * are opened in browsers/email clients, so every outcome (success, expired,
   * invalid, already-used) must land the user on a friendly page, not a JSON
   * error. The URLs should be HTTPS Universal Links / App Links so the mobile
   * app opens directly, falling back to the web page when it isn't installed.
   */
  async resolveVerifyEmailRedirect(token: string): Promise<string> {
    try {
      await this.emailVerification.verify(token);
      return this.successRedirectUrl();
    } catch (err) {
      // Tokens are deleted on use, so "already verified / already used" is
      // indistinguishable from "invalid" here — both map to `invalid`. The
      // failure page copy should tell the user to just try logging in.
      const reason = err instanceof GoneException ? 'expired' : 'invalid';
      return this.failureRedirectUrl(reason);
    }
  }

  private successRedirectUrl(): string {
    return (
      this.config.get<string>('EMAIL_VERIFY_SUCCESS_URL') ??
      'https://app.mator.uz/email-verified'
    );
  }

  private failureRedirectUrl(reason: 'expired' | 'invalid'): string {
    const base =
      this.config.get<string>('EMAIL_VERIFY_FAILURE_URL') ??
      'https://app.mator.uz/email-verification-failed';
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}reason=${reason}`;
  }

  resendVerification(email: string) {
    // Always 202/silent regardless of outcome (anti-enumeration).
    return this.emailVerification.resend(normalizeEmail(email)).then(() => ({
      message: 'If an unverified account exists for this email, a verification link has been sent.',
    }));
  }

  getMe(user: Record<string, unknown>) {
    return user;
  }

  async refresh(refreshToken: string) {
    const session = await this.tokens.rotate(refreshToken);
    return { accessToken: session.accessToken, refreshToken: session.refreshToken };
  }

  async logout(refreshToken: string) {
    await this.tokens.revoke(refreshToken);
    return { message: 'Logged out successfully' };
  }
}
