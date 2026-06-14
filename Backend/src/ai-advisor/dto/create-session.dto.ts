import { IsString, IsOptional } from 'class-validator';

export class CreateAiSessionDto {
  @IsOptional()
  @IsString()
  vehicle_id?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsString()
  entry_point?: string;
}
