import { IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * Payload for `POST /api/ai-chat/message`.
 *
 * The chat is available to anonymous customers (pre-login support), so
 * `userId` is optional and supplied by the client when known. `vin`, when
 * present, is passed to the model as a strong hint for vehicle extraction.
 */
export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  userId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  vin?: string;
}
