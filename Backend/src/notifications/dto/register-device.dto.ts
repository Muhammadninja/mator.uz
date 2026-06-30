import { IsString, IsOptional, IsIn, IsBoolean, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * Push-device registration. Idempotent on (user, install_id): re-registering the
 * same install refreshes tokens/metadata rather than creating a duplicate row.
 */
export class RegisterDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  install_id: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';

  // Client may pass a stable device id to reuse; otherwise the server mints one.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  device_id?: string;

  @IsOptional() @IsString() expo_push_token?: string;
  @IsOptional() @IsString() fcm_token?: string;
  @IsOptional() @IsString() apns_token?: string;
  @IsOptional() @IsString() @MaxLength(40) os_version?: string;
  @IsOptional() @IsString() @MaxLength(40) app_version?: string;
  @IsOptional() @IsString() @MaxLength(80) device_model?: string;
  @IsOptional() @IsString() @MaxLength(20) locale?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsBoolean() permissions_granted?: boolean;
}
