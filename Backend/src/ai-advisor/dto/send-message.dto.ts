import {
  IsString,
  IsOptional,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DEFAULT_AI_MAX_MESSAGE_CHARS } from '../ai-advisor.config';

export class SendMessageDto {
  @ApiPropertyOptional({
    description:
      'Client-generated id for this message, echoed back so a retry can be de-duplicated client-side.',
  })
  @IsOptional()
  @IsString()
  client_message_id?: string;

  @ApiPropertyOptional({ enum: ['user'] })
  @IsOptional()
  @IsIn(['user'])
  role?: string;

  @ApiProperty({
    description: 'The user message. Must be non-empty after trimming.',
    maxLength: DEFAULT_AI_MAX_MESSAGE_CHARS,
  })
  // Trim FIRST, so a whitespace-only message ("   ") fails @IsNotEmpty rather
  // than reaching the provider as an empty turn and costing a call.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  // The ceiling is enforced here, at the boundary, so an oversized payload costs
  // a 400 rather than tokens. The limit is also configurable at runtime
  // (AI_ADVISOR_MAX_MESSAGE_CHARS) and re-checked in the controller; this
  // decorator is the static contract Swagger publishes.
  @MaxLength(DEFAULT_AI_MAX_MESSAGE_CHARS)
  content: string;

  @ApiPropertyOptional({
    description:
      'Image attachments. URLs must be HTTPS on an allowed asset host.',
  })
  @IsOptional()
  @IsArray()
  attachments?: Array<{ type?: string; url?: string; mime?: string }>;

  @ApiPropertyOptional({
    description:
      'Set false to receive one JSON message instead of an SSE stream.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  stream?: boolean;
}
