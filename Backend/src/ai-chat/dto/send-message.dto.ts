import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** One prior turn of the conversation, replayed to give the model context. */
export class ChatHistoryItemDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content: string;
}

/**
 * Payload for `POST /api/ai-chat/message`.
 *
 * The chat is available to anonymous customers (pre-login support), so
 * `userId` is optional and supplied by the client when known. `vin`, when
 * present, is passed to the model as a strong hint for vehicle extraction.
 *
 * `history` carries prior turns so the (stateless) endpoint keeps context
 * across messages — e.g. the vehicle named in turn 1 is still known when the
 * part is named in turn 2. Capped so the prompt can't grow unbounded; the
 * client sends the most recent turns.
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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryItemDto)
  history?: ChatHistoryItemDto[];
}
