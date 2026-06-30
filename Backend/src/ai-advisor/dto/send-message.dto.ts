import { IsString, IsOptional, IsArray, IsBoolean, IsIn, IsNotEmpty } from 'class-validator';

export class SendMessageDto {
  @IsOptional()
  @IsString()
  client_message_id?: string;

  @IsOptional()
  @IsIn(['user'])
  role?: string;

  @IsString()
  @IsNotEmpty()
  content: string;

  @IsOptional()
  @IsArray()
  attachments?: Array<{ type?: string; url?: string; mime?: string }>;

  @IsOptional()
  @IsBoolean()
  stream?: boolean;
}
