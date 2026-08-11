import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  MAX_VAT_PERCENT,
  MIN_VAT_PERCENT,
  TIN_PATTERN,
} from '../../../common/fiscal.util';
import { ADMIN_DEALER_STATUSES } from './list-admin-dealers.query.dto';
// `import type` is required: with isolatedModules + emitDecoratorMetadata, a
// type used in a decorated signature must not be emitted as a value import.
import type { AdminDealerStatusFilter } from './list-admin-dealers.query.dto';

/**
 * Body of PATCH /v1/admin/dealers/:id — the ONLY editable dealer fields.
 *
 * Everything else a dealer row carries (name, city, gmvUzs, orders, skus,
 * joinedAt, …) is either descriptive data owned elsewhere or a derived metric,
 * and is deliberately absent here. The global ValidationPipe runs with
 * `whitelist: true, forbidNonWhitelisted: true`, so a body naming any other
 * field is rejected with 400 rather than silently ignored — this class IS the
 * whitelist.
 *
 * `status` accepts the same lowercase vocabulary as the list filter. Setting it
 * here is the escape hatch for a correction; the approve/suspend/reactivate
 * endpoints are the normal, transition-checked path.
 *
 * The presentation fields (name, city, email, phone, brandColor, initial,
 * logoUrl, orders, years) are editable so an operator can correct a dealer's
 * storefront details after creating it. They are audited together as a single
 * DEALER_UPDATED entry; certified / lowestPrice / status keep their own verbs.
 */
export class UpdateAdminDealerDto {
  @ApiPropertyOptional({ description: 'Storefront / dealer name.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ description: 'City + region.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ description: 'Public contact email.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: 'Public contact phone (E.164).' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Brand accent hex (#RRGGBB[AA]).' })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  brandColor?: string;

  @ApiPropertyOptional({ description: 'Monogram letter for the logo tile.' })
  @IsOptional()
  @IsString()
  @MaxLength(4)
  initial?: string;

  @ApiPropertyOptional({ description: 'Brand logo image URL (from POST /v1/admin/dealers/logo).' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  logoUrl?: string;

  @ApiPropertyOptional({ description: 'Pre-formatted lifetime order count, e.g. "18k+".' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  orders?: string;

  @ApiPropertyOptional({ description: 'Years in business.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  years?: number;

  // ── Налоговые данные ──────────────────────────────────────────────────────
  // Configured HERE and only here: there is no automatic tax-status lookup and
  // the Telegram seller bot never asks for them. Both are required before this
  // dealer's products can be paid for through Payme (see PaymeFiscalService),
  // and filling them in makes every existing product of the dealer payable at
  // once — no product row is touched.
  @ApiPropertyOptional({
    description:
      'ИНН (9 digits) or ПИНФЛ (14 digits). Sent to Payme as ' +
      'commission_info.tin. Empty string clears it.',
    example: '301234567',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((_, value) => value !== '')
  @Matches(TIN_PATTERN, {
    message: 'tin must be 9 digits (ИНН) or 14 digits (ПИНФЛ)',
  })
  tin?: string;

  @ApiPropertyOptional({
    description:
      'Ставка НДС in percent — the value Payme receives as vat_percent. ' +
      'Set explicitly per dealer (0 and 12 are the usual rates); it is never ' +
      'defaulted in business logic.',
    example: 12,
    minimum: MIN_VAT_PERCENT,
    maximum: MAX_VAT_PERCENT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_VAT_PERCENT)
  @Max(MAX_VAT_PERCENT)
  vatPercent?: number;

  @ApiPropertyOptional({
    description: 'MATOR-certified badge.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  certified?: boolean;

  @ApiPropertyOptional({
    description: 'Lowest-price badge.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  lowestPrice?: boolean;

  @ApiPropertyOptional({
    description: 'Moderation state.',
    enum: ADMIN_DEALER_STATUSES,
    example: 'active',
  })
  @IsOptional()
  @IsString()
  @IsIn(ADMIN_DEALER_STATUSES, {
    message: 'status must be one of: active, pending, suspended',
  })
  status?: AdminDealerStatusFilter;

  @ApiPropertyOptional({
    description:
      'Why the dealer is being suspended. Only meaningful together with ' +
      "status: 'suspended'; ignored otherwise.",
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Body of POST /v1/admin/dealers/:id/suspend — the reason is optional. */
export class SuspendAdminDealerDto {
  @ApiPropertyOptional({
    description: 'Why the dealer is being suspended. Stored and audited.',
    example: 'Manual moderation',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
