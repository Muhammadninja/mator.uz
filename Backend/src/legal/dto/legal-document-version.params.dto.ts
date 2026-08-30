import { Type } from 'class-transformer';
import { IsEnum, IsInt, Min } from 'class-validator';
import { LegalDocumentType } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Path params of GET /v1/legal/documents/:type/:version.
 *
 * Validated rather than read raw so an unknown type or a non-numeric version is
 * a 400 from the pipeline, not a Prisma error or a silent NaN lookup.
 */
export class LegalDocumentVersionParamsDto {
  @ApiProperty({ enum: LegalDocumentType, example: LegalDocumentType.PRIVACY_POLICY })
  @IsEnum(LegalDocumentType, {
    message: `type must be one of: ${Object.values(LegalDocumentType).join(', ')}`,
  })
  type: LegalDocumentType;

  @ApiProperty({ minimum: 1, example: 1 })
  // Path params arrive as strings; ValidationPipe runs with transform: true, so
  // this coerces before @IsInt sees it.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}
