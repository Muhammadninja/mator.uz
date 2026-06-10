import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { AppleLoginDto } from './dto/apple-login.dto';
import { Role } from '@prisma/client';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { GoogleVerifierService } from './social/google-verifier.service';
import { AppleVerifierService } from './social/apple-verifier.service';
import { SocialIdentityService } from './social/social-identity.service';
import { EmailVerificationService } from './email-verification/email-verification.service';
import { hashPassword, verifyPassword, needsRehash } from './password.util';
import { normalizeEmail } from './email.util';

const ACCESS_EXPIRES = '15m';
const REFRESH_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly googleVerifier: GoogleVerifierService,
    private readonly appleVerifier: AppleVerifierService,
    private readonly socialIdentity: SocialIdentityService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  private async generateTokens(userId: number, email: string, role: string) {
    const payload: JwtPayload = { sub: userId, email, role };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: ACCESS_EXPIRES,
    });

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: '7d',
    });

    // Store only a SHA-256 hash. The raw token is high-entropy (a signed JWT),
    // so a fast hash is sufficient and a DB leak cannot reveal usable tokens.
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.hashToken(refreshToken),
        userId,
        expiresAt: new Date(Date.now() + REFRESH_EXPIRES_MS),
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private strip(user: { passwordHash: string | null; [key: string]: unknown }) {
    const { passwordHash: _, ...safe } = user;
    return safe;
  }

  async googleLogin(dto: GoogleLoginDto) {
    const profile = await this.googleVerifier.verify(dto.idToken);
    const user = await this.socialIdentity.resolveUser(profile);
    const tokens = await this.generateTokens(user.id, user.email, user.role);
    return { user: this.strip(user), ...tokens };
  }

  async appleLogin(dto: AppleLoginDto) {
    const profile = await this.appleVerifier.verify(dto.identityToken, {
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
    const user = await this.socialIdentity.resolveUser(profile);
    const tokens = await this.generateTokens(user.id, user.email, user.role);
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

    const tokens = await this.generateTokens(user.id, user.email, user.role);
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
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    // Valid signature but no stored row => the token was already rotated out
    // (or is being replayed). Treat as theft: revoke the whole family.
    if (!stored) {
      await this.prisma.refreshToken.deleteMany({ where: { userId: payload.sub } });
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (stored.expiresAt < new Date()) {
      await this.prisma.refreshToken.delete({ where: { id: stored.id } });
      throw new UnauthorizedException('Refresh token revoked or expired');
    }

    // Rotation: invalidate the presented token and issue a brand-new pair.
    await this.prisma.refreshToken.delete({ where: { id: stored.id } });
    return this.generateTokens(payload.sub, payload.email, payload.role);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.deleteMany({
      where: { tokenHash: this.hashToken(refreshToken) },
    });
    return { message: 'Logged out successfully' };
  }
}
