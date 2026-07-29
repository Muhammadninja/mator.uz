import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body of PATCH /v1/admin/products/bulk-move. Reassigns many parts
 * (CatalogPart) to one target category in a single transaction.
 *
 * The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist.
 */
export class BulkMoveProductsDto {
  @ApiProperty({
    description: 'Ids of the parts to move.',
    type: [String],
    example: ['part_abc', 'part_def'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  productIds!: string[];

  @ApiProperty({
    description: 'Category id to move every listed part into.',
    example: 'engine-oil',
  })
  @IsString()
  @MaxLength(64)
  targetCategoryId!: string;
}
