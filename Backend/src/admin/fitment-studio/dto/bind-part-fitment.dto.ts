import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsString,
} from 'class-validator';
import { NodeCategory } from '@prisma/client';

/**
 * POST /v1/admin/fitment/bind — one part, many vehicles, one node.
 *
 * `vehicleModelIds` is the COMPLETE set for this (part, node): the service
 * replaces rather than appends, so sending a shorter list is how an operator
 * corrects a mis-bind. Deduped here so `boundCount` cannot disagree with the
 * number of rows written.
 */
export class BindPartFitmentDto {
  @IsString()
  partId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? [
          ...new Set(
            (value as unknown[]).filter(
              (v): v is string => typeof v === 'string' && v.trim() !== '',
            ),
          ),
        ]
      : value,
  )
  vehicleModelIds!: string[];

  /** Node CATEGORY enum (ENGINE, FRONT_BRAKES, …) — the studio's own node ids
   *  are translated at the client boundary. */
  @IsEnum(NodeCategory)
  nodeKey!: NodeCategory;
}
