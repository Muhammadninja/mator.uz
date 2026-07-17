/**
 * Legacy authentication providers.
 *
 * Intentionally NOT registered in AuthModule.
 *
 * Email/password, social, and MyID verification remain implemented for future
 * releases but are not part of the public v1 API, which is phone-first. MyID is
 * no longer part of onboarding, so its routes were moved off the active
 * AuthController to here alongside the other retired login flows.
 *
 * Do not delete this controller.
 */
import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { MyIdService } from './myid/myid.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { AppleLoginDto } from './dto/apple-login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { MyIdInitiateDto } from './myid/dto/myid-initiate.dto';
import { MyIdCallbackDto } from './myid/dto/myid-callback.dto';

/**
 * Email / password / social (Google, Apple) authentication and MyID
 * verification endpoints.
 *
 * These flows are fully implemented and intended for a future Mator release,
 * but v1 is intentionally phone-only. This controller is deliberately NOT
 * registered in AuthModule, so none of these routes are exposed over HTTP.
 * The handler bodies and their delegated AuthService / MyIdService
 * implementations remain intact — re-enabling the public API later requires
 * only adding this class back to `controllers` in auth.module.ts, with no
 * service changes.
 *
 * The route paths and decorators below are preserved exactly as they were on
 * AuthController so restoration is a pure re-registration.
 */
@ApiTags('Auth')
@Controller('v1/auth')
export class LegacyAuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly myId: MyIdService,
  ) {}

  // ── Email register / login / verify ────────────────────────────────────────────
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // Opened directly from the email client -> always 303-redirect to a
  // Universal Link / App Link, never return JSON.
  @Get('verify-email')
  async verifyEmail(@Query() dto: VerifyEmailDto, @Res() res: Response) {
    const url = await this.authService.resolveVerifyEmailRedirect(dto.token);
    res.redirect(HttpStatus.SEE_OTHER, url);
  }

  // 3 requests / hour per IP on top of the per-user 60s cooldown.
  @Post('resend-verification-email')
  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto.email);
  }

  // ── Social ───────────────────────────────────────────────────────────────────
  @Post('google')
  @HttpCode(HttpStatus.OK)
  google(@Body() dto: GoogleLoginDto) {
    return this.authService.googleLogin(dto);
  }

  @Post('apple')
  @HttpCode(HttpStatus.OK)
  apple(@Body() dto: AppleLoginDto) {
    return this.authService.appleLogin(dto);
  }

  // ── MyID (requires an authenticated session) ─────────────────────────────────
  @Post('myid/initiate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.CREATED)
  myIdInitiate(@Req() req: { user: { id: string } }, @Body() dto: MyIdInitiateDto) {
    return this.myId.initiate(req.user.id, dto);
  }

  @Post('myid/callback')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  myIdCallback(@Req() req: { user: { id: string } }, @Body() dto: MyIdCallbackDto) {
    return this.myId.callback(req.user.id, dto);
  }

  @Get('myid/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  @HttpCode(HttpStatus.OK)
  myIdStatus(
    @Req() req: { user: { id: string } },
    @Query('session_id') sessionId: string,
  ) {
    return this.myId.status(req.user.id, sessionId);
  }
}
