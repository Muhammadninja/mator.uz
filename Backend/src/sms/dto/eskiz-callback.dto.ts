import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Delivery report posted by Eskiz to ESKIZ_CALLBACK_URL.
 *
 * Every field is optional on purpose. This DTO describes a THIRD-PARTY payload
 * we do not control: Eskiz has shipped both `message_id` and `id` for the same
 * field across accounts/versions, and a rejected `@Body()` would answer 400 and
 * make Eskiz retry a report we can never accept. The endpoint therefore takes
 * whatever arrives and does its own validation in the service, where an
 * unusable report is acknowledged (200) and logged rather than bounced.
 *
 * NOTE on the global ValidationPipe: it runs with `forbidNonWhitelisted: true`,
 * which 400s any property not declared here. Eskiz is free to add fields to its
 * callback at any time, so the controller opts this route out of whitelisting
 * (see EskizWebhookController) — the DTO documents the shape, it does not
 * police it.
 */
export class EskizCallbackDto {
  /** Eskiz's message id — the value stored as SmsMessage.providerSmsId. */
  @ApiPropertyOptional({
    description: 'Eskiz message id (as returned by /message/sms/send).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  message_id?: string;

  /** Alias for {@link message_id}: some Eskiz accounts post `id` instead. */
  @ApiPropertyOptional({
    description: 'Alias for message_id used by some Eskiz accounts.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  id?: string;

  /** Delivery status, e.g. `delivered` / `rejected` / `failed` / `undelivered`. */
  @ApiPropertyOptional({
    description: 'Delivery status reported by the operator.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  @ApiPropertyOptional({ description: 'Recipient MSISDN, digits only.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone_number?: string;

  /** Free-form detail Eskiz attaches to a failure. */
  @ApiPropertyOptional({
    description: 'Human-readable reason for a non-delivered status.',
  })
  @IsOptional()
  @IsString()
  error?: string;
}
