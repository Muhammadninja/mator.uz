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
 * Body of POST /v1/admin/inventory/batch-delete. The parts (CatalogPart ids) to
 * delete for good. The global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`, so this class IS the accepted-field whitelist.
 */
export class BatchDeleteInventoryDto {
  @ApiProperty({
    description: 'Ids of the parts to delete.',
    type: [String],
    example: ['part_stock_101', 'part_stock_102'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ids!: string[];
}
