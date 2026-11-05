import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Body of PATCH /v1/admin/categories/:id/fiscal-confirmation.
 *
 * Confirming says: these exact codes were checked against Tasnif and are true of
 * EVERY listing filed on this category. So the console sends back the codes it
 * showed (`fiscalCodesToConfirm`), and a mismatch is refused: nobody confirms a code
 * another operator changed a moment ago without having seen it.
 */
export class ConfirmCategoryFiscalDto {
  @ApiProperty({
    description: 'true to confirm the codes, false to withdraw a confirmation.',
    example: true,
  })
  @IsBoolean()
  confirmed!: boolean;

  @ApiPropertyOptional({
    description:
      'Required when confirming: the fiscalCodesToConfirm value the operator checked.',
    example: '08708005011000000:1417722:1417723',
  })
  @ValidateIf((dto: ConfirmCategoryFiscalDto) => dto.confirmed === true)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  codes?: string;
}
