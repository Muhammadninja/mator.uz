import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProvider, SmsSendResult } from './sms-provider.interface';
import { LogSmsProvider } from './providers/log.provider';
import { EskizSmsProvider } from './providers/eskiz.provider';
import { PlaymobileSmsProvider } from './providers/playmobile.provider';
import { SayqalSmsProvider } from './providers/sayqal.provider';
import { PrismaService } from '../prisma/prisma.service';
import { SmsOperatorResolver, ResolvedOperator } from './resolver/sms-operator.resolver';

/**
 * Selects the active SMS provider from SMS_PROVIDER (eskiz | playmobile | sayqal
 * | log) and exposes a single send() to the rest of the app. Falls back to the
 * log provider when the chosen aggregator is missing credentials, so OTP flows
 * never hard-fail in dev.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly provider: SmsProvider;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly operatorResolver: SmsOperatorResolver,
  ) {
    this.provider = this.resolveProvider();
    this.logger.log(`SMS provider: ${this.provider.name}`);
  }

  private resolveProvider(): SmsProvider {
    const choice = (this.config.get<string>('SMS_PROVIDER') ?? 'log').toLowerCase();

    if (choice === 'eskiz') {
      const email = this.config.get<string>('ESKIZ_EMAIL');
      const password = this.config.get<string>('ESKIZ_PASSWORD');
      if (email && password) {
        return new EskizSmsProvider({
          baseUrl: this.config.get<string>('ESKIZ_BASE_URL') ?? 'https://notify.eskiz.uz/api',
          email,
          password,
          from: this.config.get<string>('ESKIZ_FROM'),
        });
      }
      this.logger.warn('SMS_PROVIDER=eskiz but credentials missing — falling back to log');
    }

    if (choice === 'playmobile') {
      const login = this.config.get<string>('PLAYMOBILE_LOGIN');
      const password = this.config.get<string>('PLAYMOBILE_PASSWORD');
      if (login && password) {
        return new PlaymobileSmsProvider({
          baseUrl:
            this.config.get<string>('PLAYMOBILE_BASE_URL') ?? 'https://send.smsxabar.uz/broker-api',
          login,
          password,
          originator: this.config.get<string>('PLAYMOBILE_ORIGINATOR') ?? '3700',
        });
      }
      this.logger.warn('SMS_PROVIDER=playmobile but credentials missing — falling back to log');
    }

    if (choice === 'sayqal') {
      const username = this.config.get<string>('SAYQAL_USERNAME');
      const secretKey = this.config.get<string>('SAYQAL_SECRET_KEY');
      const serviceId = Number(this.config.get<string>('SAYQAL_SERVICE_ID'));
      if (username && secretKey && Number.isInteger(serviceId)) {
        return new SayqalSmsProvider({
          baseUrl: this.config.get<string>('SAYQAL_BASE_URL') ?? 'https://routee.sayqal.uz',
          username,
          secretKey,
          serviceId,
          nickname: this.config.get<string>('SAYQAL_NICKNAME'),
        });
      }
      this.logger.warn(
        'SMS_PROVIDER=sayqal but SAYQAL_USERNAME/SAYQAL_SECRET_KEY/SAYQAL_SERVICE_ID missing or invalid — falling back to log',
      );
    }

    return new LogSmsProvider();
  }

  /**
   * Send an SMS and record it for accounting.
   *
   * `template` is an OPTIONAL, additive accounting label (e.g. `'otp'`,
   * `'order_paid'`) — never the rendered text, so OTP codes are never persisted.
   * Existing 2-argument callers are unaffected: it defaults to null and the
   * return type stays `void`, so callers that ignore accounting keep working.
   */
  async sendSms(toE164: string, text: string, template?: string | null): Promise<void> {
    // Resolve the operator BEFORE the send so bookkeeping never delays delivery.
    // Fully defensive: any resolver hiccup degrades to a null (unknown) operator
    // and the send proceeds exactly as before.
    const operator = await this.safeResolveOperator(toE164);

    // ── Unchanged production send path ──────────────────────────────────────
    // Identical to the pre-accounting behaviour: same provider, retries, and
    // logging. If this throws (delivery failed) we deliberately do NOT record a
    // row — accounting only reflects sends the gateway accepted. The returned
    // metadata is captured for persistence; a caller that ignores it is unaffected.
    const result = await this.provider.send(toE164, text);

    // Accounting is best-effort and MUST NOT change the send outcome: the SMS is
    // already accepted, so a persistence failure is logged and swallowed instead
    // of surfacing to the OTP flow.
    await this.recordAcceptedSms(toE164, operator, result, template ?? null);
  }

  /** Resolve the operator without ever throwing into the send path. */
  private async safeResolveOperator(toE164: string): Promise<ResolvedOperator | null> {
    try {
      return await this.operatorResolver.resolve(toE164);
    } catch (err) {
      this.logger.warn(
        `SMS operator resolution failed for a send (continuing without it): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Persist an accepted send as a `pending` SmsMessage with the operator/price
   * snapshot and the provider's returned metadata (transaction id / sms id /
   * parts — each null when the provider doesn't expose it). `status` stays
   * `pending`; a future delivery callback flips it to delivered/failed.
   */
  private async recordAcceptedSms(
    toE164: string,
    operator: ResolvedOperator | null,
    result: SmsSendResult,
    template: string | null,
  ): Promise<void> {
    try {
      await this.prisma.smsMessage.create({
        data: {
          provider: this.provider.name,
          providerTransactionId: result.providerTransactionId,
          providerSmsId: result.providerSmsId,
          parts: result.parts,
          phoneE164: toE164,
          operatorId: operator?.operatorId ?? null,
          operatorName: operator?.operatorName ?? null,
          priceUzs: operator?.priceUzs ?? null,
          template,
          status: 'pending',
        },
      });
    } catch (err) {
      this.logger.warn(
        `SMS accounting insert failed (send already succeeded): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
