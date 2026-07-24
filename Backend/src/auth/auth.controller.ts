import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { PhoneAuthService } from './phone/phone-auth.service';
import { TokenService, ACCESS_TTL_SECONDS } from './tokens/token.service';
import { AuthenticatedTokenMeta } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RefreshDto } from './dto/refresh.dto';
import { SignInDto } from './dto/sign-in.dto';
import { SignUpDto } from './dto/sign-up.dto';
import { RequestOtpDto } from './phone/dto/request-otp.dto';
import { CheckAvailabilityDto } from './phone/dto/check-availability.dto';
import { VerifyOtpDto } from './phone/dto/verify-otp.dto';
import { ResendOtpDto } from './phone/dto/resend-otp.dto';

/**
 * Request shape on JWT-guarded routes: carries the authenticated user plus the
 * current access token's identity (jti/exp), which JwtStrategy stashes so
 * logout can blacklist exactly this token.
 */
interface AuthenticatedRequest {
  user: { id: string };
  tokenMeta?: AuthenticatedTokenMeta;
}

/**
 * Public v1 authentication controller under /v1/auth. Mator v1 is phone-only,
 * so this controller exposes the phone OTP flow and the session/token
 * endpoints. Email, password, social (Google/Apple) login, and MyID
 * verification are implemented but intentionally not exposed for v1 — their
 * routes live on the unregistered LegacyAuthController (see
 * legacy-auth.controller.ts). The camelCase sign-in / sign-up aliases are
 * retained here as internal methods only (no HTTP route).
 * (Consolidated from the former V1AuthController and AuthCompatController.)
 */
@ApiTags('Auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly phoneAuth: PhoneAuthService,
    private readonly tokens: TokenService,
  ) {}

  // ── Phone OTP (primary flow) ──────────────────────────────────────────────────
  @Post('phone/request-otp')
  @Throttle({ default: { limit: 5, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.phoneAuth.requestOtp(dto);
  }

  @Post('phone/check-availability')
  @HttpCode(HttpStatus.OK)
  checkAvailability(@Body() dto: CheckAvailabilityDto) {
    return this.phoneAuth.checkAvailability(dto.phone_e164.trim());
  }

  @Post('phone/verify-otp')
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.phoneAuth.verifyOtp(dto);
  }

  @Post('phone/resend-otp')
  @Throttle({ default: { limit: 5, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.phoneAuth.resendOtp(dto.request_id);
  }

  // ── Frontend compatibility aliases (camelCase contract) ─────────────────────────
  // NOTE: signIn/signUp are email/password flows and are NOT exposed as HTTP
  // routes in v1 (no @Post decorator). The methods are retained so the internal
  // camelCase contract and its tests keep working, ready to re-route later.
  async signIn(@Body() dto: SignInDto) {
    const res = await this.authService.login({ email: dto.email, password: dto.password });
    return {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      user: res.user,
    };
  }

  signUp(@Body() dto: SignUpDto) {
    // Variant A: registration issues NO tokens — the user must verify their
    // email first; returns the same payload as /v1/auth/register.
    return this.authService.register({
      email: dto.email,
      password: dto.password,
      firstName: dto.firstName,
      lastName: dto.lastName,
    });
  }

  @Post('sign-out')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(@Request() req: AuthenticatedRequest, @Body() dto: RefreshDto) {
    await this.tokens.revoke(this.resolveRefresh(dto));
    await this.tokens.blacklistAccessToken(req.tokenMeta?.jti, req.tokenMeta?.exp);
  }

  // ── Session / token ───────────────────────────────────────────────────────────
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  me(@Request() req: { user: Record<string, unknown> }) {
    return this.authService.getMe(req.user);
  }

  // Contract refresh: camelCase response (accepts either body key).
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto) {
    const session = await this.tokens.rotate(this.resolveRefresh(dto));
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }

  // Snake_case full-envelope refresh (preserved from the former V1 controller).
  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  async tokenRefresh(@Body() dto: RefreshDto) {
    const s = await this.tokens.rotate(this.resolveRefresh(dto));
    return {
      access_token: s.accessToken,
      access_token_expires_at: s.accessTokenExpiresAt.toISOString(),
      refresh_token: s.refreshToken,
      refresh_token_expires_at: s.refreshTokenExpiresAt.toISOString(),
      token_type: s.tokenType,
    };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  async logout(@Request() req: AuthenticatedRequest, @Body() dto: RefreshDto) {
    await this.tokens.revoke(this.resolveRefresh(dto));
    // Immediately kill the access token that made this call, so it can't be used
    // again for the remainder of its lifetime (the refresh revoke above only
    // stops minting new sessions). Every other access token is untouched.
    await this.tokens.blacklistAccessToken(req.tokenMeta?.jti, req.tokenMeta?.exp);
    return { message: 'Logged out successfully' };
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sign out of every device. Drops all refresh tokens and bumps the session version, so every access token already in flight — including the one used for this call — is rejected from the next request on.',
  })
  @ApiOkResponse({
    schema: { example: { message: 'All sessions revoked', token_version: 3 } },
  })
  async logoutAll(@Request() req: { user: { id: string } }) {
    const tokenVersion = await this.tokens.revokeAllSessions(req.user.id);
    return { message: 'All sessions revoked', token_version: tokenVersion };
  }

  /** Resolve the refresh token from either camelCase or snake_case body key. */
  private resolveRefresh(dto: RefreshDto): string {
    const token = dto.refreshToken ?? dto.refresh_token;
    if (!token) throw new BadRequestException('refreshToken (or refresh_token) is required');
    return token;
  }
}
