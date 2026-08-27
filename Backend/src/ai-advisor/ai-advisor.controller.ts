import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Request,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiAdvisorService } from './ai-advisor.service';
import { ClaudeService } from './claude.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateAiSessionDto } from './dto/create-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { resolveRequestLang } from '../common/app-lang.util';

@ApiTags('AI Advisor')
@ApiBearerAuth('jwt')
@Controller('v1/ai/sessions')
@UseGuards(JwtAuthGuard)
export class AiAdvisorController {
  constructor(
    private readonly ai: AiAdvisorService,
    private readonly claude: ClaudeService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Notify the user that an assistant reply is ready (ai_reply_ready). */
  private notifyReply(
    userId: string,
    sessionId: string,
    saved: { id: string; content: string },
  ) {
    return this.notifications.emit(userId, {
      type: NotificationType.AI_REPLY,
      title: 'AI maslahatchidan javob',
      body: saved.content.slice(0, 120),
      data: { session_id: sessionId, message_id: saved.id },
      deeplinkPath: `/(tabs)/(advisor)/session/${sessionId}`,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Open an AI advisor session, optionally bound to a garage vehicle.',
  })
  @ApiCreatedResponse({
    description: 'Session created; returns the resolved vehicle context.',
  })
  @ApiNotFoundResponse({
    description: "The vehicle does not exist or is not the caller's.",
  })
  createSession(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateAiSessionDto,
  ) {
    return this.ai.createSession(req.user.id, dto);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Restore a session's message history, oldest first.",
  })
  @ApiOkResponse({ description: 'The session and its ordered messages.' })
  @ApiNotFoundResponse({ description: 'No such session for this user.' })
  restore(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.ai.restore(req.user.id, id);
  }

  /**
   * Send a user message and receive the assistant's reply.
   *
   * Order of operations is deliberate, and each step guards the next:
   *   1. session ownership  — a 404 before anything is written or spent;
   *   2. size check         — an oversized message costs a 400, not tokens;
   *   3. rate limit         — a throttled user costs neither tokens nor a row;
   *   4. persist the user's message;
   *   5. run the turn (tool calls included) and persist the reply.
   *
   * The reply is produced by one {@link ClaudeService.reply} call that runs the
   * catalogue tools to completion, so provider failures surface as a normal
   * assistant message carrying `structured.error` rather than as a broken stream.
   */
  @Post(':id/messages')
  @ApiOperation({
    summary: 'Send a message; reply streams over SSE unless stream=false.',
  })
  @ApiOkResponse({
    description:
      'SSE stream of `delta` frames, then a `message` frame, then `event: done`. With stream=false, one JSON message object.',
  })
  @ApiBadRequestResponse({
    description: 'Empty, oversized, or malformed message.',
  })
  @ApiNotFoundResponse({ description: 'No such session for this user.' })
  @ApiTooManyRequestsResponse({
    description: 'Per-user AI message budget exhausted.',
  })
  async sendMessage(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    const { session, context } = await this.ai.assertSessionWithVehicle(
      req.user.id,
      id,
    );

    // Re-check the size against the RUNTIME limit. The DTO's @MaxLength pins the
    // published default; this honours an env override without a redeploy.
    if (dto.content.length > this.claude.maxMessageChars) {
      throw new BadRequestException(
        `content must be at most ${this.claude.maxMessageChars} characters`,
      );
    }

    await this.ai.assertWithinRateLimit(
      req.user.id,
      this.claude.rateLimit,
      this.claude.rateWindowSeconds,
    );

    await this.ai.persistUserMessage(id, dto);

    const system = this.claude.buildSystem(context);
    const messages = await this.ai.toClaudeMessages(
      id,
      this.claude.historyLimit,
    );
    // The catalogue tools name categories in the SESSION's language — the
    // locale the client chose at createSession, already persisted on the row.
    // Reusing it (rather than reading a header here) keeps ONE language context
    // for the conversation, so a mid-chat request cannot switch the model's
    // vocabulary. An unset/unsupported locale falls back to the default.
    const reply = await this.claude.reply(
      system,
      messages,
      resolveRequestLang(session.locale),
    );
    const structured = this.ai.buildStructured(reply.citedItems, reply.outcome);
    const saved = await this.ai.persistAssistantMessage(
      id,
      reply.text,
      structured,
    );
    await this.notifyReply(req.user.id, id, saved);
    const finalMessage = this.ai.presentMessage(saved, structured);

    // Non-streaming mode returns the full message object.
    if (dto.stream === false) {
      res.json(finalMessage);
      return;
    }

    // SSE. The frame contract is unchanged for the client — one or more `delta`
    // frames, a `message` frame, then the named `done` event and the legacy
    // `[DONE]` sentinel. Token-by-token streaming is not possible while the turn
    // may issue tool calls (the text is only final once the tools have run), so
    // the completed reply is emitted as a single delta rather than pretending to
    // stream. The client's existing accumulate-deltas-then-take-`message` logic
    // works unchanged either way.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      res.write(
        `data: ${JSON.stringify({ type: 'delta', text: reply.text })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: 'message', message: finalMessage })}\n\n`,
      );
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: finalMessage })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
    } finally {
      res.end();
    }
  }
}
