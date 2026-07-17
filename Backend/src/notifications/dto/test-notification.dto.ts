import { IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';

/**
 * Payload for the dev-only POST /v1/notifications/test endpoint. Mirrors the
 * internal {@link EmitInput} so the endpoint can hand it straight to
 * NotificationsService.emit() without any parallel creation logic. Only usable
 * when AUTH_DEV_MODE=true.
 */
export class TestNotificationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  body!: string;

  // `ORDER` has no exact enum member; the closest production analog is
  // ORDER_PAID, which is used as the default when `type` is omitted.
  @ApiPropertyOptional({ enum: NotificationType, default: NotificationType.ORDER_PAID })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({ description: 'Deep-link path opened when the notification is tapped.' })
  @IsOptional()
  @IsString()
  deeplink_path?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
