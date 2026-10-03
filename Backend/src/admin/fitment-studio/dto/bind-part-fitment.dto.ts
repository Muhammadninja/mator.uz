import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsString,
} from 'class-validator';
import { NodeCategory } from '@prisma/client';

/**
 * Trim string entries and drop exact duplicates, keeping order. Non-strings
 * and blanks are deliberately KEPT so validation rejects them — silently
 * filtering them out would turn a malformed `['']` into an empty set, which
 * now means "clear this node" (see vehicleModelIds below).
 */
export const dedupeIds = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? [
        ...new Set(
          (value as unknown[]).map((v) =>
            typeof v === 'string' ? v.trim() : v,
          ),
        ),
      ]
    : value;

/**
 * POST /v1/admin/fitment/bind — one part, many vehicles, one node.
 *
 * `vehicleModelIds` is the COMPLETE set for this (part, node): the service
 * replaces rather than appends, so sending a shorter list is how an operator
 * corrects a mis-bind — and sending an EMPTY list clears every binding of this
 * part at this node (other nodes are untouched). Deduped here so `boundCount`
 * cannot disagree with the number of rows written.
 */
export class BindPartFitmentDto {
  @IsString()
  partId!: string;

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @Transform(dedupeIds)
  vehicleModelIds!: string[];

  /** Node CATEGORY enum (ENGINE, FRONT_BRAKES, …) — the studio's own node ids
   *  are translated at the client boundary. */
  @IsEnum(NodeCategory)
  nodeKey!: NodeCategory;
}
