import { IsOptional, IsString, IsIn, MaxLength, Matches } from 'class-validator';

export const LANGUAGES = ['RU', 'UZ', 'EN'] as const;

/** Partial profile update — every field optional. Language accepts ru/uz/en in
 * any case and is normalized to the Prisma enum in the service. */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  display_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  last_name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/.+/i, { message: 'avatar_url must be an http(s) URL' })
  avatar_url?: string;

  @IsOptional()
  @IsString()
  @IsIn([...LANGUAGES, 'ru', 'uz', 'en'], { message: 'language must be one of RU, UZ, EN' })
  language?: string;
}
