import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { SmsService } from './sms.service';
import { EskizCallbackDto } from './dto/eskiz-callback.dto';

/**
 * Eskiz delivery reports (ESKIZ_CALLBACK_URL).
 *
 * No JWT: this is a gateway-to-server callback, so there is no user session to
 * authenticate against — same posture as the Payme/Click webhooks. Throttle-
 * exempt because a delivery-report burst after an OTP campaign is legitimate
 * traffic, and a 429 would make Eskiz redeliver reports we simply refused.
 *
 * A report carries no secret and is not trusted to do anything dangerous: the
 * only effect is closing a `pending` row whose id was minted by Eskiz itself
 * and stored by us, scoped to `provider='eskiz'`. A forged callback can at worst
 * mark an SMS we really sent as delivered/failed — it cannot create rows, read
 * anything back, or touch another provider's messages.
 */
@ApiTags('SMS / Webhooks')
@Controller('v1/sms/webhooks')
@SkipThrottle()
export class EskizWebhookController {
  constructor(private readonly sms: SmsService) {}

  /**
   * Always answers 200, whatever the payload says.
   *
   * Eskiz retries a report that does not get a 2xx, and none of our failure
   * modes (unknown id, unmapped status, DB hiccup) are cured by redelivery —
   * so a non-2xx would only produce a retry storm. The outcome is logged by
   * {@link SmsService.applyEskizCallback} instead.
   *
   * `whitelist`/`forbidNonWhitelisted` are switched off for this route only:
   * the global pipe would 400 any field Eskiz adds to its callback later, and
   * a 400 here means an endlessly redelivered report. Unknown fields are simply
   * ignored; the handler reads nothing it has not declared.
   */
  @Post('eskiz')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Eskiz delivery report callback (no auth — gateway-to-server).',
  })
  @ApiOkResponse({
    description: 'Report acknowledged. Always 200 to prevent redelivery.',
  })
  async eskizCallback(
    @Body(
      new ValidationPipe({
        whitelist: false,
        forbidNonWhitelisted: false,
        transform: true,
      }),
    )
    body: EskizCallbackDto,
  ): Promise<{ success: true }> {
    await this.sms.applyEskizCallback({
      // Eskiz has shipped both spellings for this field; prefer the documented
      // one and fall back to `id`.
      messageId: body.message_id ?? body.id,
      status: body.status,
      error: body.error,
    });

    return { success: true };
  }
}
