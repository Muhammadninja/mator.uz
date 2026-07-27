import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
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
 */
export class UpdateAdminDealerDto {
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
