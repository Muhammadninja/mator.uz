import { IsOptional, IsBoolean, IsString, Matches } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Partial update of the per-user notification preferences (all fields optional). */
export class UpdatePreferencesDto {
  @IsOptional() @IsBoolean() orders?: boolean;
  @IsOptional() @IsBoolean() payments?: boolean;
  @IsOptional() @IsBoolean() ai_replies?: boolean;
  @IsOptional() @IsBoolean() master_messages?: boolean;
  @IsOptional() @IsBoolean() marketing?: boolean;

  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: 'quiet_hours_start must be HH:MM' })
  quiet_hours_start?: string;

  @IsOptional()
  @IsString()
  @Matches(HHMM, { message: 'quiet_hours_end must be HH:MM' })
  quiet_hours_end?: string;
}
