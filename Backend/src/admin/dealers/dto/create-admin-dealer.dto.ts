import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
 * Body of POST /v1/admin/dealers — create a curated storefront from the console.
 *
 * `name` is the only required field. Everything else is optional with a sensible
 * server-side default: a dealer created here is a real, operator-vetted
 * storefront meant to go live, so the service defaults it to ACTIVE + certified
 * and marks it curated (isCurated), which is exactly what makes it show up in the
 * app's MATOR Certified rail (GET /v1/dealers filters on curated + certified +
 * ACTIVE). The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist.
 *
 * `logoUrl` should point at an uploaded asset — the console uploads the brand
 * icon via POST /v1/admin/dealers/logo first and passes the returned URL here.
 */
export class CreateAdminDealerDto {
  @ApiProperty({ description: 'Storefront / dealer name.', example: 'BYD Motors' })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ description: 'City + region.', example: 'Toshkent, UZ' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ description: 'Public contact email.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: 'Public contact phone (E.164).', example: '+998901234567' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Brand accent hex (#RRGGBB[AA]).', example: '#2A6FDB' })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  brandColor?: string;

  @ApiPropertyOptional({
    description: 'Monogram letter for the logo tile when no logo is set. Derived from the name when omitted.',
    example: 'B',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4)
  initial?: string;

  @ApiPropertyOptional({ description: 'Brand logo image URL (from POST /v1/admin/dealers/logo).' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  logoUrl?: string;

  @ApiPropertyOptional({ description: 'Pre-formatted lifetime order count for the storefront card.', example: '18k+' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  orders?: string;

  @ApiPropertyOptional({ description: 'Years in business.', example: 12 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  years?: number;

  // ── Налоговые данные ──────────────────────────────────────────────────────
  // Optional at creation: a dealer may be onboarded before its tax data is
  // known, and its sellers can list products meanwhile. Only Payme checkout
  // requires them (see PaymeFiscalService), so they can be filled in later via
  // PATCH without touching a single product.
  @ApiPropertyOptional({
    description: 'ИНН (9 digits) or ПИНФЛ (14 digits).',
    example: '301234567',
  })
  @IsOptional()
  @IsString()
  @Matches(TIN_PATTERN, {
    message: 'tin must be 9 digits (ИНН) or 14 digits (ПИНФЛ)',
  })
  tin?: string;

  @ApiPropertyOptional({
    description: 'Ставка НДС in percent (e.g. 0 or 12).',
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

  @ApiPropertyOptional({ description: 'MATOR-certified badge. Defaults to true for a console-created dealer.', example: true })
  @IsOptional()
  @IsBoolean()
  certified?: boolean;

  @ApiPropertyOptional({ description: 'Lowest-price badge. Defaults to false.', example: false })
  @IsOptional()
  @IsBoolean()
  lowestPrice?: boolean;

  @ApiPropertyOptional({
    description: 'Moderation state. Defaults to active for a console-created dealer.',
    enum: ADMIN_DEALER_STATUSES,
    example: 'active',
  })
  @IsOptional()
  @IsString()
  @IsIn(ADMIN_DEALER_STATUSES, {
    message: 'status must be one of: active, pending, suspended',
  })
  status?: AdminDealerStatusFilter;
}
