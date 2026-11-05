import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';
import type { AddressSearchLanguage } from '../search/address-search-provider';

/** Query for GET /v1/addresses/reverse: a point the buyer has just confirmed on the map. */
export class AddressPointQueryDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsIn(['uz', 'ru', 'en'])
  lang?: AddressSearchLanguage;
}
