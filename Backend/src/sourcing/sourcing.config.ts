import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Sourcing settings, all optional. `ticketsEnabled` is off unless explicitly
 * turned on: it is the release switch, and turning it off again is the rollback.
 */
@Injectable()
export class SourcingConfig {
  private readonly logger = new Logger(SourcingConfig.name);

  readonly ticketsEnabled: boolean;
  readonly staffNotifyMaxAttempts: number;
  readonly escalateAfterMs: number;
  readonly noOfferAfterMs: number;
  readonly offerTtlMs: number;
  readonly duplicateWindowMs: number;
  readonly idempotencyLeaseMs: number;
  readonly idempotencyWaitMs: number;
  readonly llmTimeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.ticketsEnabled = config.get<string>('SOURCING_TICKETS_ENABLED')?.trim() === 'true';
    this.staffNotifyMaxAttempts = this.positiveInt('SOURCING_STAFF_NOTIFY_MAX_ATTEMPTS', 8);
    this.escalateAfterMs = this.positiveInt('SOURCING_ESCALATE_AFTER_MINUTES', 30) * MINUTE;
    this.noOfferAfterMs = this.positiveInt('SOURCING_NO_OFFER_AFTER_HOURS', 48) * HOUR;
    this.offerTtlMs = this.positiveInt('SOURCING_OFFER_TTL_HOURS', 72) * HOUR;
    this.duplicateWindowMs = this.positiveInt('SOURCING_DUPLICATE_WINDOW_MINUTES', 60) * MINUTE;
    // The wait and the model timeout stay under the app's 45-second timeout, so
    // the server answers before the app gives up.
    this.idempotencyLeaseMs = this.positiveInt('SOURCING_IDEMPOTENCY_LEASE_SECONDS', 60) * 1000;
    this.idempotencyWaitMs = this.positiveInt('SOURCING_IDEMPOTENCY_WAIT_SECONDS', 30) * 1000;
    this.llmTimeoutMs = this.positiveInt('SOURCING_LLM_TIMEOUT_SECONDS', 18) * 1000;
  }

  private positiveInt(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) return value;
    this.logger.warn(`${key}="${raw}" is not a positive integer; using ${fallback}`);
    return fallback;
  }
}
