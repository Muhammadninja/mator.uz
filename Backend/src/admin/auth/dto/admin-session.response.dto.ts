import { ApiProperty } from '@nestjs/swagger';
import { AdminRole } from '@prisma/client';

/** Token pair returned by login and refresh. */
export class AdminSessionResponseDto {
  @ApiProperty({ description: 'Admin access token (JWT, HS256).' })
  accessToken: string;

  @ApiProperty({ description: 'Opaque refresh token. Rotated on every use.' })
  refreshToken: string;

  @ApiProperty({
    description: 'Access token lifetime in seconds.',
    example: 900,
  })
  expiresIn: number;
}

/**
 * One active session (one signed-in device), as returned by
 * GET /v1/auth/admin/sessions. Carries no credential material: the refresh
 * token exists only as a hash and is never exposed.
 */
export class AdminSessionSummaryDto {
  @ApiProperty({ description: 'Session id — pass to DELETE /sessions/{id}.' })
  id: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "Jane's MacBook",
    description: 'Client-supplied label. Display-only, never trusted.',
  })
  deviceName: string | null;

  @ApiProperty({ type: String, nullable: true, example: '203.0.113.42' })
  ip: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Last time this session refreshed its token.',
  })
  lastUsedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
}

/**
 * The current administrator, as returned by GET /v1/auth/admin/me. Contains no
 * sensitive material — no passwordHash, no tokens, no session bookkeeping.
 */
export class AdminProfileResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'admin@example.com' })
  email: string;

  @ApiProperty({ example: 'Jane Doe' })
  name: string;

  @ApiProperty({ enum: AdminRole, example: AdminRole.SUPER_ADMIN })
  role: AdminRole;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLoginAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
