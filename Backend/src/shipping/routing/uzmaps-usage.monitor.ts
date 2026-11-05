import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { MetricsService } from '../../metrics/metrics.service';
import {
  UzmapsKeyRole,
  uzmapsRoutingKey,
  uzmapsSearchKey,
} from './uzmaps-keys';

/** https://docs.uzmaps.uz/keys-usage/ Reading it is not billable and uses no allowance. */
const USAGE_URL = 'https://uzmaps.uz/api/usage';
const TIMEOUT_MS = 10_000;

/** Used up by this much, an operator has time to act before courier pricing stops. */
const WARN_AT = 0.8;
const ALARM_AT = 0.95;

/**
 * Watches the UzMaps monthly allowance from UzMaps' own count, which is the one that decides
 * when requests start being refused. Hourly, since the figure moves slowly and each read still
 * counts against the key's rate limit. Publishes it to Prometheus and warns in the log.
 */
@Injectable()
export class UzmapsUsageMonitor {
  private readonly logger = new Logger(UzmapsUsageMonitor.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, {
    name: 'uzmaps-usage-monitor',
    timeZone: 'UTC',
  })
  async check(): Promise<void> {
    const get = (key: string) => this.config.get<string>(key);
    const routing = uzmapsRoutingKey(get);
    const search = uzmapsSearchKey(get);
    if (routing) await this.read('routing', routing);
    if (search && search !== routing) await this.read('search', search);
  }

  private async read(role: UzmapsKeyRole, key: string): Promise<void> {
    let quota: unknown;
    try {
      const response = await axios.get<{ quota?: unknown }>(USAGE_URL, {
        headers: { 'X-API-Key': key },
        timeout: TIMEOUT_MS,
      });
      quota = response.data?.quota;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      this.logger.warn(
        `Could not read UzMaps usage for the ${role} key: ${status ?? 'no answer'}`,
      );
      return;
    }

    // Absent when the key has no monthly limit.
    const { limit, used } = (quota ?? {}) as Record<string, unknown>;
    if (typeof limit !== 'number' || typeof used !== 'number' || limit <= 0) {
      return;
    }
    this.metrics?.setUzmapsQuota(role, limit, used);

    const share = used / limit;
    const line = `UzMaps ${role} key has used ${used} of ${limit} requests this month`;
    if (share >= ALARM_AT) this.logger.error(line);
    else if (share >= WARN_AT) this.logger.warn(line);
  }
}
