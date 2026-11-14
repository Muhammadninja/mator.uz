import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OtpService } from './otp.service';

/**
 * Staging tester inbox: the codes pending for the tester the staging proxy
 * authenticated (see staging-otp.config.ts). 404 everywhere else, including
 * production, and kept out of the public API docs.
 */
@ApiExcludeController()
@Controller('v1/staging/otp')
export class StagingOtpController {
  constructor(private readonly otp: OtpService) {}

  @Get('inbox')
  @Header('Cache-Control', 'no-store')
  async inbox() {
    const entries = await this.otp.stagingInbox();
    return {
      items: entries.map((e) => ({
        request_id: e.requestId,
        phone: e.phoneE164,
        purpose: e.purpose,
        code: e.code,
        expires_at: e.expiresAt.toISOString(),
      })),
    };
  }
}
