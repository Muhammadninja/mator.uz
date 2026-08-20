import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsOptional, IsObject, IsIn, Matches } from 'class-validator';
import {
  SMS_LANGS,
  resolveSmsLang,
  type SmsLang,
} from '../../../sms/otp-message.i18n';

// E.164: +<country><number>, 7–15 digits total.
export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class RequestOtpDto {
  @Matches(E164_REGEX, { message: 'phone_e164 must be a valid E.164 number' })
  phone_e164: string;

  @IsOptional()
  @IsString()
  country_iso2?: string;

  @IsOptional()
  @IsString()
  @IsIn(['sms', 'telegram'])
  channel?: string;

  /**
   * Language of the OTP SMS body. Optional — omitted means `uz`.
   *
   * Normalized BEFORE validation rather than rejected: `'RU'`, `'ru-RU'` and
   * `'uz_lat'` are folded onto the supported set, and anything we have no copy
   * for degrades to `uz`. A locale we do not translate must never turn a login
   * request into a 400, so `@IsIn` here only ever sees an already-valid value —
   * it guards the type, not the client.
   */
  @ApiPropertyOptional({
    enum: SMS_LANGS,
    default: 'uz',
    description: 'OTP SMS language. Unknown or omitted values fall back to uz.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? undefined
      : resolveSmsLang(String(value)),
  )
  @IsIn(SMS_LANGS)
  lang?: SmsLang;

  // Accepted (and ignored server-side) so the client's analytics envelope and
  // captcha token don't trip forbidNonWhitelisted.
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Optional client analytics envelope; ignored server-side.',
  })
  @IsOptional()
  @IsObject()
  client?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  captcha_token?: string;
}
