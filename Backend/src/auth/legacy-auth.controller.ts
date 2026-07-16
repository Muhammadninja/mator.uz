/**
 * Legacy authentication providers.
 *
 * Intentionally NOT registered in AuthModule.
 *
 * Email/password and social authentication remain implemented for future
 * releases but are not part of the public v1 API, which is phone-first.
 *
 * Do not delete this controller.
 */
import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { AppleLoginDto } from './dto/apple-login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';

/**
 * Email / password / social (Google, Apple) authentication endpoints.
 *
 * These flows are fully implemented and intended for a future Mator release,
 * but v1 is intentionally phone-only. This controller is deliberately NOT
 * registered in AuthModule, so none of these routes are exposed over HTTP.
 * The handler bodies and their delegated AuthService implementations remain
 * intact — re-enabling the public API later requires only adding this class
 * back to `controllers` in auth.module.ts, with no service changes.
 *
 * The route paths and decorators below are preserved exactly as they were on
 * AuthController so restoration is a pure re-registration.
 */
@ApiTags('Auth')
@Controller('v1/auth')
export class LegacyAuthController {
  constructor(private readonly authService: AuthService) {}

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
}
