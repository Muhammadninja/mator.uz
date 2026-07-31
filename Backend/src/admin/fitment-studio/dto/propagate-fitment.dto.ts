import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/** POST /v1/admin/fitment-studio/propagate-node
 *  Copy every binding of one node from a source model onto other models
 *  (e.g. Lacetti → Gentra, Cobalt). */
export class PropagateFitmentDto {
  @IsString()
  sourceVehicleModelId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  targetVehicleModelIds!: string[];

  @IsString()
  nodeId!: string;
}
