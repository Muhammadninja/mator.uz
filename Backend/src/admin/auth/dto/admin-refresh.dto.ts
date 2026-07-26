import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Refresh-token payload for rotation (/refresh) and logout (/logout). */
export class AdminRefreshDto {
  @ApiProperty({
    example: 'art_9f8c…',
    description: 'The opaque refresh token issued at login.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  refreshToken: string;
}
