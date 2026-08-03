import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiChatService, ChatResponse } from './ai-chat.service';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('api/ai-chat')
export class AiChatController {
  constructor(private readonly aiChat: AiChatService) {}

  /**
   * Customer support + part-sourcing chat.
   *
   * Public (anonymous support), so on top of the global 100-req/min baseline
   * this route is tightened to 15/min per client to bound OpenAI spend against
   * abuse. Returns the structured {@link ChatResponse}.
   */
  @Post('message')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 15 } })
  sendMessage(@Body() dto: SendMessageDto): Promise<ChatResponse> {
    return this.aiChat.processUserMessage(dto);
  }
}
