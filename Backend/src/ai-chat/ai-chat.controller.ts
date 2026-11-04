import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtUnlessAnonymousGuard } from '../auth/guards/optional-jwt-auth.guard';
import { AiChatService, ChatResponse } from './ai-chat.service';
import { SendMessageDto } from './dto/send-message.dto';

const REQUEST_ID = /^[A-Za-z0-9:_-]{8,128}$/;

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
   * Guests get chat and catalogue matches, but only a verified bearer can create
   * a ticket: the owner comes from that token alone, and `dto.userId` is discarded
   * so a caller can't tie a ticket to someone else's account. A token that fails
   * is answered with 401 rather than treated as a guest.
   */
  @Post('message')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 15 } })
  @UseGuards(JwtUnlessAnonymousGuard)
  sendMessage(
    @Body() dto: SendMessageDto,
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-selected-vehicle-id') selectedVehicleId?: string,
  ): Promise<ChatResponse> {
    if (idempotencyKey !== undefined && !REQUEST_ID.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be 8 to 128 letters, digits, ":", "_" or "-".',
      });
    }
    const userId = (req.user as { id?: string } | undefined)?.id ?? null;
    // Verified id wins; anonymous → null (never trust the client-supplied field).
    dto.userId = userId ?? undefined;
    return this.aiChat.processUserMessage(dto, {
      userId,
      idempotencyKey: idempotencyKey ?? null,
      selectedVehicleId: selectedVehicleId?.slice(0, 64) || null,
    });
  }
}
