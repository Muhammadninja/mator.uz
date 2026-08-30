import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  Min,
  ValidateNested,
} from 'class-validator';
import { LegalDocumentType } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { NoDuplicateDocumentTypes } from './no-duplicate-document-types.validator';

/**
 * Hard ceiling on the array. Duplicate types are rejected anyway, so no LEGITIMATE
 * request can exceed the number of document types that exist — this simply stops
 * a hostile client from making the server validate a huge array element by
 * element before reaching that conclusion.
 */
const MAX_ACCEPTANCES = Object.keys(LegalDocumentType).length;

/** One claimed acceptance: "I accepted this document at this version". */
export class LegalAcceptanceItemDto {
  @ApiProperty({
    enum: LegalDocumentType,
    description:
      'The document being accepted. An unknown value is rejected by the enum ' +
      'check, so a typo can never be recorded as consent to something.',
  })
  @IsEnum(LegalDocumentType, {
    message: `type must be one of: ${Object.values(LegalDocumentType).join(', ')}`,
  })
  type: LegalDocumentType;

  @ApiProperty({
    minimum: 1,
    example: 1,
    description:
      'The version the client believes it displayed. It is CHECKED against the ' +
      'currently active version, never trusted — see LegalService.accept.',
  })
  @IsInt()
  @Min(1)
  version: number;
}

/**
 * Body of POST /v1/legal/accept.
 *
 * `version` here is a CLAIM about what the client showed the user, not an
 * instruction. The service resolves the genuinely-required version from the DB
 * and rejects the request when the two disagree, so a client cannot consent on
 * a user's behalf to a version that is no longer (or not yet) in force.
 */
export class AcceptLegalDocumentsDto {
  @ApiProperty({
    type: [LegalAcceptanceItemDto],
    description:
      'Must contain every currently-required document exactly once. A missing ' +
      'document or a repeated type is rejected.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ACCEPTANCES)
  @ValidateNested({ each: true })
  @Type(() => LegalAcceptanceItemDto)
  // A repeated `type` makes the request self-contradictory ("v1 and also v2"),
  // and silently keeping the last one would record consent the user never gave.
  @NoDuplicateDocumentTypes()
  acceptances: LegalAcceptanceItemDto[];
}
