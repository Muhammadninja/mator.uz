import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
} from 'class-validator';
import { dedupeIds } from './bind-part-fitment.dto';

/** POST /v1/admin/fitment-studio/propagate-node
 *  Copy every binding of one node from a source model onto other models
 *  (e.g. Lacetti → Gentra, Cobalt). Targets are deduped; the service rejects a
 *  self-target and unknown ids with 400 before anything is written. */
export class PropagateFitmentDto {
  @IsString()
  @IsNotEmpty()
  sourceVehicleModelId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @Transform(dedupeIds)
  targetVehicleModelIds!: string[];

  @IsString()
  @IsNotEmpty()
  nodeId!: string;
}
