import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PackageForm, ProductKind } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
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

  @ApiPropertyOptional({
    description:
      'The kind the operator states these parts ARE, when the move changes it: ' +
      'a spare part filed by mistake that is really a motor oil. A move never ' +
      'changes a kind unless this says so, and it is recorded in the audit trail.',
    enum: ProductKind,
  })
  @IsOptional()
  @IsEnum(ProductKind)
  kind?: ProductKind;

  @ApiPropertyOptional({
    description:
      'How these parts are sold, when the operator states it. A part that states no ' +
      'form cannot be paid for online on a category holding more than one package ' +
      'code, so this is how existing parts get one: send their current category as ' +
      'the target to change nothing else. Refused when the target has no code for ' +
      'this form. Recorded in the audit trail.',
    enum: PackageForm,
  })
  @IsOptional()
  @IsEnum(PackageForm)
  packageForm?: PackageForm;
}
