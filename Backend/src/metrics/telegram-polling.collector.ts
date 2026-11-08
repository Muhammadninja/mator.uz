import { Injectable, Optional } from '@nestjs/common';
import { TelegramPollingStatus } from '../telegram/polling-status';
import { MetricsService } from './metrics.service';

/**
 * Samples the seller bot's polling status into the registry at scrape time —
 * pull-based like the queue collector, so a scrape shows the status as of that
 * request (a stalled loop included) rather than as of the last transition.
 *
 * Reads process memory only: no Redis, no database, no Telegram request.
 * Without TelegramPollingStatus (a process that never builds the bot) it
 * publishes nothing.
 */
@Injectable()
export class TelegramPollingCollector {
  constructor(
    private readonly metrics: MetricsService,
    @Optional() private readonly status?: TelegramPollingStatus,
  ) {}

  collect(): void {
    if (!this.status || !this.metrics.enabled) return;
    this.metrics.setTelegramPolling(this.status.current());
  }
}
