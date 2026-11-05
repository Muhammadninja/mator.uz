import { ApiPropertyOptional } from '@nestjs/swagger';
import { PackageForm } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body of PATCH /v1/admin/sourcing-tickets/offers/:offerId/classification. Replaces
 * the offer's classification as a whole: a null or absent field clears it.
 */
export class ClassifySourcingOfferDto {
  @ApiPropertyOptional({
    description:
      'The category that describes this part and supplies its MXIK. Null clears it, ' +
      'which makes the offer unpayable online again.',
    example: 'brake-discs',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  categoryId?: string | null;

  @ApiPropertyOptional({
    description:
      'How it is sold. Needed when the category holds more than one package code: ' +
      'absent there leaves the offer unpayable online, never assumed to be a piece.',
    enum: PackageForm,
    nullable: true,
  })
  @IsOptional()
  @IsEnum(PackageForm)
  packageForm?: PackageForm | null;
}
