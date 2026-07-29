import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body of POST /v1/admin/brands. `name` is the only required field; `id` may be
 * supplied to pin the slug, otherwise it is derived from the name and made
 * unique by the service. The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist.
 */
export class CreateAdminBrandDto {
  @ApiProperty({ description: 'Brand (make) name.', example: 'Toyota' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    description: 'Explicit slug id. Derived from the name when omitted.',
    example: 'toyota',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @ApiPropertyOptional({ description: 'Logo image URL.', nullable: true })
  @IsOptional()
  @IsString()
  logoUrl?: string | null;

  @ApiPropertyOptional({
    description: 'Country of origin.',
    example: 'Japan',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string | null;

  @ApiPropertyOptional({
    description: 'Whether the brand is active (visible in the catalog).',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description:
      'Teaser flag — shown in the app dimmed with a "Soon" badge and not tappable.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  comingSoon?: boolean;
}
