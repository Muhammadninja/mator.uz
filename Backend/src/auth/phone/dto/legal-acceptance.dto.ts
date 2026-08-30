import { IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Legal consent supplied at registration, on POST /v1/auth/phone/verify-otp.
 *
 * Every field is the version the client BELIEVES it displayed. The backend
 * resolves the versions actually in force and rejects the request when they
 * disagree — a client cannot decide which version counts as current (see
 * LegalService.validateClaims).
 *
 * Required for a phone number that has no account yet (registration). Existing
 * users signing in are not blocked by this block's absence; they re-accept
 * through POST /v1/legal/accept after GET /v1/legal/status reports
 * requires_acceptance, so publishing a new version never locks anyone out.
 */
export class LegalAcceptanceInputDto {
  @ApiProperty({ minimum: 1, example: 1, description: 'Accepted TERMS_OF_USE version.' })
  @IsInt()
  @Min(1)
  terms_version: number;

  @ApiProperty({ minimum: 1, example: 1, description: 'Accepted PRIVACY_POLICY version.' })
  @IsInt()
  @Min(1)
  privacy_version: number;

  @ApiProperty({
    minimum: 1,
    example: 1,
    description: 'Accepted PERSONAL_DATA_CONSENT version.',
  })
  @IsInt()
  @Min(1)
  personal_data_consent_version: number;
}
