import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type {
  AddressSearchLanguage,
  AddressSearchMode,
} from '../search/address-search-provider';

/** Query for GET /v1/addresses/suggestions: what the buyer has typed so far. */
export class AddressSuggestionsQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  street!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  house?: string;

  /** Orders the results, it does not filter them. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsIn(['uz', 'ru', 'en'])
  lang?: AddressSearchLanguage;

  /** 'autocomplete' while typing, 'search' when the buyer submits what they typed. */
  @IsOptional()
  @IsIn(['autocomplete', 'search'])
  mode?: AddressSearchMode;

  /** Where the map is looking, to rank what is near it first. Used only as a pair. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  near_lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  near_lng?: number;
}
