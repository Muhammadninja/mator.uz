import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * Money that went wrong and needs a person: a fiscal receipt the tax authority did not
 * accept, a receipt that contradicts the one on file, a cancellation receipt with no sale
 * receipt before it, a refund Payme asked for and could not get, a refund made outside Payme
 * with no confirmed return receipt.
 *
 * Raised here and delivered by OpsModule (FinanceAlertListener), which hands it to the same
 * channels the queue monitor uses, so it reaches whoever reads those. Through an event, so the
 * payment path does not depend on alerting: with no listener, the log line is all there is.
 * Raising never throws, and never holds up the call that found the problem.
 */
export const FINANCE_ALERT_EVENT = 'finance.alert';

export type FinanceAlertType =
  /** Payme reports a receipt the tax authority did not accept. */
  | 'fiscal_receipt_failed'
  /** A receipt differs from an accepted one on file, or arrives where none should. */
  | 'fiscal_receipt_conflict'
  /** Payme asked to refund a payment, and the refund was refused. */
  | 'refund_refused'
  /**
   * Money went back outside Payme (cash, a terminal, a transfer) and no return receipt is
   * confirmed: none was recorded, or only an operator's word for one.
   */
  | 'refund_receipt_unconfirmed';

export interface FinanceAlert {
  type: FinanceAlertType;
  severity: 'warning' | 'critical';
  /** The one line an operator reads first. Names the payment and the order. */
  message: string;
  /** Ids and codes, for finding the case. Never a customer's personal data. */
  context: Record<string, string | number | null>;
}

@Injectable()
export class FinanceAlerts {
  private readonly logger = new Logger(FinanceAlerts.name);

  constructor(@Optional() private readonly events?: EventEmitter2) {}

  raise(alert: FinanceAlert): void {
    const line = `[${alert.type}] ${alert.message} ${JSON.stringify(alert.context)}`;
    if (alert.severity === 'critical') this.logger.error(line);
    else this.logger.warn(line);
    try {
      this.events?.emit(FINANCE_ALERT_EVENT, alert);
    } catch (err) {
      this.logger.error(
        `Finance alert could not be handed on: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
