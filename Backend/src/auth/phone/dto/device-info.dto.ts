import { IsString, IsOptional, IsIn } from 'class-validator';

export class DeviceInfoDto {
  @IsString()
  install_id: string;

  @IsString()
  @IsIn(['ios', 'android'])
  platform: string;

  @IsOptional()
  @IsString()
  expo_push_token?: string;

  @IsOptional()
  @IsString()
  fcm_token?: string;

  @IsOptional()
  @IsString()
  apns_token?: string;
}
