import { IsString, IsOptional, IsNumber, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class NearbyQueryDto {
  @Type(() => Number)
  @IsNumber()
  center_lat: number;

  @Type(() => Number)
  @IsNumber()
  center_lng: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50000)
  radius_m?: number;

  @IsOptional() @Type(() => Number) @IsNumber() viewport_min_lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() viewport_min_lng?: number;
  @IsOptional() @Type(() => Number) @IsNumber() viewport_max_lat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() viewport_max_lng?: number;

  // comma-separated specialization keys (engine,transmission,…)
  @IsOptional()
  @IsString()
  specialization?: string;

  @IsOptional()
  @IsString()
  vehicle_make_id?: string;

  @IsOptional()
  @IsString()
  vehicle_model_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  min_rating?: number;

  @IsOptional()
  @IsString()
  open_now?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  // STO-only: comma-separated service types
  @IsOptional()
  @IsString()
  service_types?: string;
}
