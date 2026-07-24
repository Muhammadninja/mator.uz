import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Operator snapshot for a resolved phone number — the exact triple the accounting
 * layer freezes onto {@link SmsMessage} at send time.
 */
export interface ResolvedOperator {
  operatorId: number;
  operatorName: string;
  priceUzs: number;
}

/**
 * Maps an Uzbek MSISDN to its mobile operator (and current price) for SMS
 * accounting.
 *
 * The operator/prefix table is tiny and effectively static, so it is loaded ONCE
 * and cached in memory — there is no database query per SMS. The cache is a
 * memoized promise: concurrent first-callers share a single load, and a transient
 * load failure clears the memo so a later call can retry (rather than poisoning
 * the cache forever). {@link invalidate} drops the cache after a price/prefix edit.
 */
@Injectable()
export class SmsOperatorResolver {
  private readonly logger = new Logger(SmsOperatorResolver.name);

  /** prefix (2 digits after 998) -> operator snapshot. */
  private cache: Promise<Map<string, ResolvedOperator>> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the operator for an E.164 (or otherwise formatted) phone number.
   * Returns `null` for any number that is not a well-formed `998XXXXXXXXX`
   * MSISDN or whose prefix is not in the operator table — the caller treats a
   * null resolution as "unknown operator" and still records the SMS.
   */
  async resolve(phoneE164: string): Promise<ResolvedOperator | null> {
    const digits = phoneE164.replace(/\D/g, '');
    // Expect the Uzbek MSISDN form 998 + 9 national digits (12 total).
    if (!/^998\d{9}$/.test(digits)) return null;

    const prefix = digits.slice(3, 5); // 2-digit operator code after the 998.
    const table = await this.getTable();
    return table.get(prefix) ?? null;
  }

  /** Drop the in-memory cache; the next {@link resolve} reloads from the database. */
  invalidate(): void {
    this.cache = null;
  }

  private getTable(): Promise<Map<string, ResolvedOperator>> {
    if (!this.cache) {
      this.cache = this.load().catch((err) => {
        // Do not let a transient DB error poison the cache permanently.
        this.cache = null;
        throw err;
      });
    }
    return this.cache;
  }

  private async load(): Promise<Map<string, ResolvedOperator>> {
    const table = new Map<string, ResolvedOperator>();
    const operators = await this.prisma.smsOperator.findMany({
      where: { isActive: true },
      include: { prefixes: true },
    });
    for (const op of operators) {
      for (const { prefix } of op.prefixes) {
        table.set(prefix, {
          operatorId: op.id,
          operatorName: op.name,
          priceUzs: op.priceUzs,
        });
      }
    }
    this.logger.log(`Loaded ${table.size} SMS operator prefix(es) into cache`);
    return table;
  }
}
