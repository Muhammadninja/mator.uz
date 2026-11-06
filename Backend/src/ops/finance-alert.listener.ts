import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  FINANCE_ALERT_EVENT,
  type FinanceAlert,
} from '../orders/finance-alerts';
import { AlertService } from './alert.service';

/**
 * Hands the money side's alerts (src/orders/finance-alerts.ts) to the same channels the
 * queue monitor uses: the log, and through OpsAlertBridge whatever the alerting module is
 * configured to reach. One "queue" for all of them, `payments`, so a burst of the same kind
 * is held back by the usual cooldown and counted rather than paged one by one: the list of
 * open cases is the admin finance view, not the channel.
 */
@Injectable()
export class FinanceAlertListener {
  constructor(private readonly alerts: AlertService) {}

  @OnEvent(FINANCE_ALERT_EVENT)
  async handle(alert: FinanceAlert): Promise<void> {
    await this.alerts.raise({
      type: alert.type,
      severity: alert.severity,
      queue: 'payments',
      message: alert.message,
      context: alert.context,
      firedAt: new Date(),
    });
  }
}
