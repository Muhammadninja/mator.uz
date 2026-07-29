import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Body of PATCH /v1/admin/categories/:id/move. Reparents a category and,
 * optionally, sets its order among the new siblings.
 *
 * `parentId: null` promotes the category to a root. The service rejects a move
 * that would create a cycle (parent = self or a descendant) with 400. The
 * global ValidationPipe runs with `whitelist: true, forbidNonWhitelisted: true`,
 * so this class IS the accepted-field whitelist.
 */
export class MoveCategoryDto {
  @ApiProperty({
    description:
      'New parent category id, or null to make this a root category.',
    nullable: true,
    example: 'engine',
  })
  // Required key, but its value may be null. `@ValidateIf` skips the string
  // checks when the value is null, so a null is an explicit "promote to root"
  // while a non-null value must be a ≤64-char string.
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  parentId!: string | null;

  @ApiPropertyOptional({
    description: 'Order among the new siblings (0-based). Left as-is when omitted.',
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
