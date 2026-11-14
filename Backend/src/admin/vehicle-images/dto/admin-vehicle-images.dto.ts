import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** The reviewer's statement that the image shows exactly this vehicle. */
export class IdentityConfirmationDto {
  @Equals(true)
  confirmed!: true;

  /** What was checked, e.g. "chevrolet.uz Tracker page, grille and lamps". */
  @IsString()
  @Length(4, 500)
  reference!: string;
}

/** The build years the approved image applies to (same make, model, trim, body and market). */
export class ApprovalScopeDto {
  @IsInt()
  @Min(1886)
  @Max(2200)
  yearFrom!: number;

  @IsInt()
  @Min(1886)
  @Max(2200)
  yearTo!: number;
}

export class ApproveCandidateDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => IdentityConfirmationDto)
  identityConfirmation?: IdentityConfirmationDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalScopeDto)
  scope?: ApprovalScopeDto;
}

export class RejectCandidateDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class ReconcileDto {
  /** False (default) reports what would change and writes nothing. */
  @IsOptional()
  @IsBoolean()
  apply?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  batchSize?: number;
}

export class RevertReconcileDto {
  @IsString()
  @Length(4, 40)
  runId!: string;

  @IsOptional()
  @IsBoolean()
  apply?: boolean;
}
