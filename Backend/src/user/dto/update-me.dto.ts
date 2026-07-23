import {
  IsOptional,
  IsString,
  IsIn,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsAllowedAssetUrl } from '../../common/is-allowed-asset-url.validator';
import { AddressInputDto } from './address-input.dto';

export const LANGUAGES = ['RU', 'UZ', 'EN'] as const;

/** Partial profile update — every field optional. Language accepts ru/uz/en in
 * any case and is normalized to the Prisma enum in the service. */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  display_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  last_name?: string;

  @IsOptional()
  @IsString()
  // Only HTTPS URLs on a configured trusted asset host (ASSET_URL_ALLOWED_HOSTS)
  // are accepted, so a profile can't store an arbitrary external/attacker URL.
  @IsAllowedAssetUrl({
    message: 'avatar_url must be an HTTPS URL on an allowed asset host',
  })
  avatar_url?: string;

  @IsOptional()
  @IsString()
  @IsIn([...LANGUAGES, 'ru', 'uz', 'en'], {
    message: 'language must be one of RU, UZ, EN',
  })
  language?: string;

  // Optional inline address. When present, it upserts the caller's DEFAULT
  // address in the existing Address table via AddressesService (single source of
  // truth) — no new column is added to the user. Omit to leave addresses
  // untouched.
  @ApiPropertyOptional({ type: AddressInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressInputDto)
  address?: AddressInputDto;
}
