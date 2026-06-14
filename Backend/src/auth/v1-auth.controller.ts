import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PhoneAuthService } from './phone/phone-auth.service';
import { MyIdService } from './myid/myid.service';
import { TokenService } from './tokens/token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RequestOtpDto } from './phone/dto/request-otp.dto';
import { CheckAvailabilityDto } from './phone/dto/check-availability.dto';
import { VerifyOtpDto } from './phone/dto/verify-otp.dto';
import { ResendOtpDto } from './phone/dto/resend-otp.dto';
import { MyIdInitiateDto } from './myid/dto/myid-initiate.dto';
import { MyIdCallbackDto } from './myid/dto/myid-callback.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

@Controller('v1/auth')
export class V1AuthController {
  constructor(
    private readonly phoneAuth: PhoneAuthService,
    private readonly myId: MyIdService,
    private readonly tokens: TokenService,
  ) {}

  // ── Phone OTP ───────────────────────────────────────────────────────────────
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

  // ── MyID (requires an authenticated session) ─────────────────────────────────
  @Post('myid/initiate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  myIdInitiate(@Request() req: { user: { id: string } }, @Body() dto: MyIdInitiateDto) {
    return this.myId.initiate(req.user.id, dto);
  }

  @Post('myid/callback')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  myIdCallback(@Request() req: { user: { id: string } }, @Body() dto: MyIdCallbackDto) {
    return this.myId.callback(req.user.id, dto);
  }

  @Get('myid/status')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  myIdStatus(
    @Request() req: { user: { id: string } },
    @Query('session_id') sessionId: string,
  ) {
    return this.myId.status(req.user.id, sessionId);
  }

  // ── Token refresh (shared by all flows) ──────────────────────────────────────
  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto) {
    const s = await this.tokens.rotate(dto.refresh_token);
    return {
      access_token: s.accessToken,
      access_token_expires_at: s.accessTokenExpiresAt.toISOString(),
      refresh_token: s.refreshToken,
      refresh_token_expires_at: s.refreshTokenExpiresAt.toISOString(),
      token_type: s.tokenType,
    };
  }
}
