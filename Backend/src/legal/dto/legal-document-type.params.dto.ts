import { IsEnum } from 'class-validator';
import { LegalDocumentType } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Path params of GET /v1/legal/documents/:type.
 *
 * Validated so an unknown type is a 400 from the pipeline, not a Prisma error.
 */
export class LegalDocumentTypeParamsDto {
  @ApiProperty({ enum: LegalDocumentType, example: LegalDocumentType.REFUND_POLICY })
  @IsEnum(LegalDocumentType, {
    message: `type must be one of: ${Object.values(LegalDocumentType).join(', ')}`,
  })
  type: LegalDocumentType;
}
