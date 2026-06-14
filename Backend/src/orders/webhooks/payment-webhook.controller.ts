import { Controller, Post, Body, Headers, HttpCode, HttpStatus } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PaymeService } from './payme.service';
import { ClickService } from './click.service';

/**
 * Provider-to-server callbacks. No JWT (the providers authenticate themselves:
 * Payme via Basic auth, Click via MD5 signature) and throttle-exempt.
 */
@Controller('v1/payments')
@SkipThrottle()
export class PaymentWebhookController {
  constructor(
    private readonly payme: PaymeService,
    private readonly click: ClickService,
  ) {}

  @Post('payme/webhook')
  @HttpCode(HttpStatus.OK)
  paymeWebhook(
    @Headers('authorization') auth: string | undefined,
    @Body() body: Record<string, any>,
  ) {
    return this.payme.handle(auth, body);
  }

  @Post('click/webhook')
  @HttpCode(HttpStatus.OK)
  clickWebhook(@Body() body: Record<string, any>) {
    // Click uses one endpoint with action: 0 = Prepare, 1 = Complete.
    return Number(body.action) === 0 ? this.click.prepare(body) : this.click.complete(body);
  }
}
