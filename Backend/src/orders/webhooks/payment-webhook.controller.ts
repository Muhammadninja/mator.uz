import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PaymeService } from './payme.service';
import { ClickService } from './click.service';

/**
 * Provider-to-server callbacks. No JWT (the providers authenticate themselves:
 * Payme via Basic auth, Click via MD5 signature) and throttle-exempt.
 */
@ApiTags('Payments / Webhooks')
@Controller('v1/payments')
@SkipThrottle()
export class PaymentWebhookController {
  constructor(
    private readonly payme: PaymeService,
    private readonly click: ClickService,
  ) {}

  /**
   * Payme Merchant API. Always answers HTTP 200 — the protocol carries success
   * and failure alike inside the JSON-RPC envelope, and any other status is read
   * by Payme as -32400. The body is taken from `req.body` rather than a `@Body()`
   * DTO so an unparseable payload reaches {@link PaymeService.handleRaw}, which
   * answers -32700, instead of being turned into an HTTP 400 upstream.
   */
  @Post('payme/webhook')
  @HttpCode(HttpStatus.OK)
  paymeWebhook(
    @Headers('authorization') auth: string | undefined,
    @Req() req: { body?: unknown },
  ) {
    return this.payme.handleRaw(auth, req.body);
  }

  @Post('click/webhook')
  @HttpCode(HttpStatus.OK)
  clickWebhook(@Body() body: Record<string, any>) {
    // Click uses one endpoint with action: 0 = Prepare, 1 = Complete.
    return Number(body.action) === 0
      ? this.click.prepare(body)
      : this.click.complete(body);
  }
}
