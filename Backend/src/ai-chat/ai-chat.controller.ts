import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { AiChatService, ChatResponse } from './ai-chat.service';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('api/ai-chat')
export class AiChatController {
  constructor(private readonly aiChat: AiChatService) {}

  /**
   * Customer support + part-sourcing chat.
   *
   * Public (anonymous support), so on top of the global 100-req/min baseline
   * this route is tightened to 15/min per client to bound LLM spend against
   * abuse. Returns the structured {@link ChatResponse}.
   *
   * The route is wrapped in {@link OptionalJwtAuthGuard}: it never rejects, but
   * a valid bearer populates `req.user`. The ticket owner is taken ONLY from
   * that verified id — the client-supplied `dto.userId` is discarded so a caller
   * can't tie a ticket (and its offer notifications) to someone else's account.
   * No token → anonymous ticket (`userId` null), which simply can't receive
   * offer notifications.
   */
  @Post('message')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 15 } })
  @UseGuards(OptionalJwtAuthGuard)
  sendMessage(
    @Body() dto: SendMessageDto,
    @Req() req: Request,
  ): Promise<ChatResponse> {
    const authedUserId = (req.user as { id?: string } | undefined)?.id;
    // Verified id wins; anonymous → null (never trust the client-supplied field).
    dto.userId = authedUserId ?? undefined;
    return this.aiChat.processUserMessage(dto);
  }
}
