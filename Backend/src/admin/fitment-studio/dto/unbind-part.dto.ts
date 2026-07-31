import { IsString } from 'class-validator';

/** DELETE /v1/admin/fitment-studio/unbind */
export class UnbindPartDto {
  @IsString()
  productId!: string;

  @IsString()
  vehicleModelId!: string;

  @IsString()
  nodeId!: string;
}
