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
import { RedisService, withRedisTimeout } from '../redis/redis.service';
import {
  TelegramPollingStatus,
  pollingHealthView,
} from '../telegram/polling-status';

const HEALTH_REDIS_TIMEOUT_MS = 1_000;
/**
 * How long a readiness answer is reused. The route is public and unthrottled so
 * a probe is never rate-limited; without this, anyone could turn it into a
 * stream of database queries and Redis pings. Two seconds is far below any
 * probe interval and bounds the cost at one check per window.
 */
const READY_TTL_MS = 2_000;

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
    @Optional() private readonly redis?: RedisService,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'ok', uptime_s: Math.round(process.uptime()) };
  }

  private readyAt = 0;
  private readyCheck: Promise<Record<string, unknown>> | null = null;

  @Get()
  @HttpCode(HttpStatus.OK)
  ready() {
    if (!this.readyCheck || Date.now() - this.readyAt >= READY_TTL_MS) {
      this.readyAt = Date.now();
      this.readyCheck = this.checkReady();
      // A failed check is still an answer for the window, not an unhandled one.
      this.readyCheck.catch(() => undefined);
    }
    return this.readyCheck;
  }

  private async checkReady(): Promise<Record<string, unknown>> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
    // Reported, not gating: without Redis the catalogue still reads, while sign-in,
    // OTP and everything else needing it answers 503 until Redis is back.
    const redis = await this.redisStatus();
    const base = {
      status: redis === 'down' ? 'degraded' : 'ok',
      database: 'up',
      ...(redis ? { redis } : {}),
    };
    if (!this.polling) return base;
    const { status, reason } = this.polling.current();
    return { ...base, telegram: { polling: status, reason } };
  }

  private async redisStatus(): Promise<'up' | 'down' | undefined> {
    if (!this.redis) return undefined;
    try {
      await withRedisTimeout(
        this.redis.getClient().ping(),
        HEALTH_REDIS_TIMEOUT_MS,
        'health PING',
      );
      return 'up';
    } catch {
      return 'down';
    }
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
