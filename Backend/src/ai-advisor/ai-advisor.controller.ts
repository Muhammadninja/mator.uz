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
} from '@nestjs/common';
import type { Response } from 'express';
import { NotificationType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiAdvisorService } from './ai-advisor.service';
import { ClaudeService } from './claude.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateAiSessionDto } from './dto/create-session.dto';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('v1/ai/sessions')
@UseGuards(JwtAuthGuard)
export class AiAdvisorController {
  constructor(
    private readonly ai: AiAdvisorService,
    private readonly claude: ClaudeService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Notify the user that an assistant reply is ready (ai_reply_ready). */
  private notifyReply(userId: string, sessionId: string, saved: { id: string; content: string }) {
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
  createSession(@Request() req: { user: { id: string } }, @Body() dto: CreateAiSessionDto) {
    return this.ai.createSession(req.user.id, dto);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  restore(@Request() req: { user: { id: string } }, @Param('id') id: string) {
    return this.ai.restore(req.user.id, id);
  }

  @Post(':id/messages')
  async sendMessage(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    const { vehicle, context } = await this.ai.assertSessionWithVehicle(req.user.id, id);
    await this.ai.persistUserMessage(id, dto);

    const system = this.claude.buildSystem(context);
    const messages = await this.ai.toClaudeMessages(id);

    // Non-streaming mode returns the full message object.
    if (dto.stream === false) {
      const text = await this.claude.fullReply(system, messages);
      const structured = await this.ai.buildStructured(vehicle);
      const saved = await this.ai.persistAssistantMessage(id, text, structured);
      await this.notifyReply(req.user.id, id, saved);
      res.json(this.ai.presentMessage(saved, structured));
      return;
    }

    // SSE: stream assistant tokens, then a final `message` frame.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let full = '';
    try {
      for await (const delta of this.claude.streamReply(system, messages)) {
        full += delta;
        res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
      }
      const structured = await this.ai.buildStructured(vehicle);
      const saved = await this.ai.persistAssistantMessage(id, full, structured);
      await this.notifyReply(req.user.id, id, saved);
      const finalMessage = this.ai.presentMessage(saved, structured);
      res.write(`data: ${JSON.stringify({ type: 'message', message: finalMessage })}\n\n`);
      // Named terminal frame per the frontend contract (`event: done`), kept
      // alongside the legacy `data: [DONE]` sentinel for backward compatibility.
      res.write(`event: done\ndata: ${JSON.stringify({ message: finalMessage })}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'generation_failed' })}\n\n`);
    } finally {
      res.end();
    }
  }
}
