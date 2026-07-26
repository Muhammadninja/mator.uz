import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AlertNotifierService } from './alert-notifier.service';
import {
  ALERT_STATE,
  AlertSeverity,
  alertFingerprint,
  parseSeverity,
  severityName,
  type AlertChannel,
  type AlertNotification,
  ALERT_CHANNELS,
} from './alerting.types';
import { ALERT_SOURCE } from './build-info';
import type { AlertSource } from './alerting.types';

/**
 * Request body — every field optional; the defaults are the smoke test.
 *
 * The decorators are load-bearing, not decoration: the global ValidationPipe
 * runs `whitelist` + `forbidNonWhitelisted`, which allowlist properties purely
 * from class-validator metadata. Without them this class has an EMPTY allowlist,
 * and since `transform: true` instantiates it (the Swagger CLI plugin adds field
 * initializers, so the keys exist even for a `{}` body) every property reads as
 * non-whitelisted and the endpoint 400s on any input, including none.
 */
export class TestAlertDto {
  /** INFO | WARNING | ERROR | CRITICAL. Defaults to WARNING (see below). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  severity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

/**
 * The dedupe key used by the test alert. Fixed and clearly synthetic so a test
 * message can never be mistaken for a real incident in the logs, and so it
 * cannot collide with a rule-generated key.
 */
export const TEST_ALERT_DEDUPE_KEY = 'manual_test{source="admin_endpoint"}';

/**
 * End-to-end smoke test for the alerting pipeline: builds one synthetic
 * notification and pushes it through the REAL notifier, so a success proves the
 * whole chain — backend → BullMQ enqueue → AlertProcessor → channel client →
 * Telegram Bot API (token + chatId) — rather than any one piece of it.
 *
 * ── Why this bypasses the rules, not the delivery ──
 * It calls `AlertNotifierService.notify` directly instead of firing a rule.
 * Rules are the part you do NOT want to exercise here: making one true requires
 * really backing up a queue or downing the database. Everything downstream of
 * the rule — fan-out, jobId, the queue, retry policy, rendering, the HTTP call —
 * is shared with production alerts and is what this actually tests.
 *
 * ── Severity default ──
 * WARNING, not INFO. Channels filter on `minSeverity`, whose default floor is
 * WARNING, so an INFO test would be dropped by `accepts()` and report success
 * while sending nothing — the exact false negative a smoke test must not have.
 * Pass `{"severity":"info"}` deliberately to test that the floor works.
 *
 * ADMIN-guarded like the rest of the ops surface: it reaches a third-party API
 * and writes to a live queue, so it is not an open endpoint.
 */
@ApiTags('Admin')
@ApiBearerAuth('jwt')
@Controller('api/admin/alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@SkipThrottle()
export class AlertTestController {
  constructor(
    private readonly notifier: AlertNotifierService,
    @Inject(ALERT_CHANNELS) private readonly channels: readonly AlertChannel[],
    @Inject(ALERT_SOURCE) private readonly source: AlertSource,
  ) {}

  /**
   * Send a test alert through the live pipeline.
   *
   * The response reports which channels were ELIGIBLE (configured and accepting
   * this severity) — the notifier itself is fire-and-forget and never throws, so
   * without this the caller could not distinguish "delivered" from "no channel
   * was configured". An empty `channels` array means nothing was sent, and the
   * accompanying hint says which env var is missing.
   */
  @Post('test')
  @HttpCode(HttpStatus.ACCEPTED)
  async test(@Body() body: TestAlertDto = {}) {
    const severity = parseSeverity(body.severity, AlertSeverity.WARNING);
    const notification = this.buildNotification(body, severity);

    const eligible = this.channels
      .filter((c) => c.configured && c.accepts(notification))
      .map((c) => c.name);

    await this.notifier.notify(notification);

    return {
      status: 'enqueued',
      severity: severityName(severity),
      fingerprint: notification.fingerprint,
      channels: eligible,
      hint:
        eligible.length > 0
          ? 'Enqueued for delivery. Check the channel; if nothing arrives, inspect the alerts queue in Bull Board for a failed job.'
          : 'No channel is configured AND accepting this severity — nothing was sent. Set ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID, and check ALERT_MIN_SEVERITY / ALERT_TELEGRAM_MIN_SEVERITY against this severity.',
    };
  }

  /** Assemble a well-formed notification so every renderer has what it needs. */
  private buildNotification(
    body: TestAlertDto,
    severity: AlertSeverity,
  ): AlertNotification {
    const title = body.title?.trim() || 'Telegram Test';
    const summary =
      body.message?.trim() || 'Alerting pipeline is working end to end.';

    return {
      dedupeKey: TEST_ALERT_DEDUPE_KEY,
      fingerprint: alertFingerprint(TEST_ALERT_DEDUPE_KEY),
      state: ALERT_STATE.ACTIVE,
      rule: 'manual_test',
      severity,
      labels: { source: 'admin_endpoint' },
      values: {},
      title,
      summary,
      source: this.source,
      // Real timestamp: it is what the jobId is keyed on, so two tests in a row
      // are distinct jobs rather than one collapsing into the other.
      firedAt: Date.now(),
    };
  }
}
