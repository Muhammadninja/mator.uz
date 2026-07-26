import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Email + password credentials for the admin panel. */
export class AdminLoginDto {
  @ApiProperty({ example: 'admin@example.com', maxLength: 255 })
  @IsEmail()
  @MaxLength(255)
  // Emails are stored lowercase; normalize at the boundary so login is
  // case-insensitive on the local part's casing, as users expect.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;

  @ApiPropertyOptional({
    example: "Jane's MacBook",
    maxLength: 120,
    description:
      'Optional label for this device, shown in the active-sessions list. ' +
      'Display-only — never used for any authorization decision.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;

  @ApiProperty({ example: 'S3cure-p4ssw0rd', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  // Argon2id imposes no length limit, but an unbounded password is a cheap
  // DoS vector (the KDF cost is paid before authentication succeeds), so the
  // input is capped. 72 also keeps any legacy bcrypt hash verifiable in full.
  @MaxLength(72)
  password: string;
}
