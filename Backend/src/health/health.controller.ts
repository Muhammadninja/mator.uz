import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import {
  TelegramPollingStatus,
  pollingHealthView,
} from '../telegram/polling-status';

/**
 * Liveness/readiness probe for load balancers and orchestrators. `/health`
 * checks DB reachability with a trivial query; `/health/live` is a cheap
 * process-up signal that never touches the database.
 *
 * The seller bot's long polling is reported, never gating: the API serves
 * buyers whether or not the bot polls, so `/health` keeps answering by the
 * database alone and only CARRIES the bot's status. `/health/telegram` is the
 * probe for the bot itself.
 */
@ApiTags('Health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly polling?: TelegramPollingStatus,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'ok', uptime_s: Math.round(process.uptime()) };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
    if (!this.polling) return { status: 'ok', database: 'up' };
    const { status, reason } = this.polling.current();
    return {
      status: 'ok',
      database: 'up',
      telegram: { polling: status, reason },
    };
  }

  /**
   * The bot's polling status in full. 200 while it is running or starting, or
   * when this instance deliberately does not poll (TELEGRAM_POLLING_DISABLED);
   * 503 when polling is in error or stopped — what a monitor alerts on.
   * Written straight to the response so the body stays this shape (the global
   * exception filter would rewrite an exception's).
   */
  @Get('telegram')
  telegram(@Res({ passthrough: true }) res: Response) {
    // Without the status module nothing polls here: stopped/not_started.
    const snapshot = (this.polling ?? new TelegramPollingStatus()).current();
    const healthy =
      snapshot.status === 'running' ||
      snapshot.status === 'starting' ||
      snapshot.reason === 'disabled';
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return pollingHealthView(snapshot);
  }
}
