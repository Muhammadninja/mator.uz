import { IsIn, IsOptional, IsString } from 'class-validator';

/** POST /v1/admin/fitment-studio/bind */
export class BindPartDto {
  @IsString()
  productId!: string;

  @IsString()
  vehicleModelId!: string;

  @IsString()
  nodeId!: string;

  /** Defaults to EXACT_MATCH server-side. UNIVERSAL is set via propagate/other flows. */
  @IsOptional()
  @IsString()
  @IsIn(['EXACT_MATCH', 'MAYBE'])
  status?: 'EXACT_MATCH' | 'MAYBE';
}
