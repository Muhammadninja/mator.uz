import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import { SmsProvider, SmsSendResult } from './sms-provider.interface';
import { LogSmsProvider } from './providers/log.provider';
import { EskizSmsProvider } from './providers/eskiz.provider';
import { PlaymobileSmsProvider } from './providers/playmobile.provider';
import { SayqalSmsProvider } from './providers/sayqal.provider';
import { PrismaService } from '../prisma/prisma.service';
import {
  SmsOperatorResolver,
  ResolvedOperator,
} from './resolver/sms-operator.resolver';
import {
  mapEskizStatus,
  isInterimStatus,
  SmsDeliveryStatus,
} from './eskiz-callback.util';

/**
 * What a delivery report did to the ledger. Returned for logging and tests —
 * the webhook answers 200 regardless (see SmsService.applyEskizCallback).
 */
export interface SmsCallbackOutcome {
  outcome: 'updated' | 'no_match' | 'ignored' | 'error';
  status?: SmsDeliveryStatus;
  reason?: 'missing_message_id' | 'interim_status' | 'unknown_status';
}

/**
 * Selects the active SMS provider from SMS_PROVIDER (eskiz | playmobile | sayqal
 * | log) and exposes a single send() to the rest of the app. Falls back to the
 * log provider when the chosen aggregator is missing credentials, so OTP flows
 * never hard-fail in dev.
 *
 * The one exception is `SMS_PROVIDER=eskiz` under `NODE_ENV=production`: missing
 * credentials there throw at construction, so the app refuses to start rather
 * than booting "healthy" while every OTP goes to the log and no user is reached.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly provider: SmsProvider;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly operatorResolver: SmsOperatorResolver,
    // Prometheus counters for sent/failed sends. `@Optional()` so the existing
    // unit tests, which construct SmsService with three arguments, keep working
    // unchanged; the global MetricsModule always satisfies it in the app.
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.provider = this.resolveProvider();
    this.logger.log(`SMS provider: ${this.provider.name}`);
  }

  /** True only for a real production boot — the fail-fast guard's trigger. */
  private isProduction(): boolean {
    return (
      (this.config.get<string>('NODE_ENV') ?? '').toLowerCase() === 'production'
    );
  }

  private resolveProvider(): SmsProvider {
    const choice = (
      this.config.get<string>('SMS_PROVIDER') ?? 'log'
    ).toLowerCase();

    if (choice === 'eskiz') {
      const email = this.config.get<string>('ESKIZ_EMAIL');
      const password = this.config.get<string>('ESKIZ_PASSWORD');
      if (email && password) {
        return new EskizSmsProvider({
          baseUrl:
            this.config.get<string>('ESKIZ_BASE_URL') ??
            'https://notify.eskiz.uz/api',
          email,
          password,
          from: this.config.get<string>('ESKIZ_FROM'),
          callbackUrl: this.config.get<string>('ESKIZ_CALLBACK_URL'),
        });
      }
      // In production a silent fallback means every OTP is written to the log
      // and no user ever receives one, while the service reports itself healthy.
      // Refuse to boot instead: a crash-looping deploy is far cheaper to notice
      // than an auth flow that is quietly dead. Dev/test keep the log fallback.
      if (this.isProduction()) {
        throw new Error(
          'SMS_PROVIDER=eskiz requires ESKIZ_EMAIL and ESKIZ_PASSWORD in production ' +
            '(refusing to fall back to the log provider and silently drop every OTP)',
        );
      }
      this.logger.warn(
        'SMS_PROVIDER=eskiz but credentials missing — falling back to log',
      );
    }

    if (choice === 'playmobile') {
      const login = this.config.get<string>('PLAYMOBILE_LOGIN');
      const password = this.config.get<string>('PLAYMOBILE_PASSWORD');
      if (login && password) {
        return new PlaymobileSmsProvider({
          baseUrl:
            this.config.get<string>('PLAYMOBILE_BASE_URL') ??
            'https://send.smsxabar.uz/broker-api',
          login,
          password,
          originator:
            this.config.get<string>('PLAYMOBILE_ORIGINATOR') ?? '3700',
        });
      }
      this.logger.warn(
        'SMS_PROVIDER=playmobile but credentials missing — falling back to log',
      );
    }

    if (choice === 'sayqal') {
      const username = this.config.get<string>('SAYQAL_USERNAME');
      const secretKey = this.config.get<string>('SAYQAL_SECRET_KEY');
      const serviceId = Number(this.config.get<string>('SAYQAL_SERVICE_ID'));
      if (username && secretKey && Number.isInteger(serviceId)) {
        return new SayqalSmsProvider({
          baseUrl:
            this.config.get<string>('SAYQAL_BASE_URL') ??
            'https://routee.sayqal.uz',
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
  async sendSms(
    toE164: string,
    text: string,
    template?: string | null,
  ): Promise<void> {
    // Resolve the operator BEFORE the send so bookkeeping never delays delivery.
    // Fully defensive: any resolver hiccup degrades to a null (unknown) operator
    // and the send proceeds exactly as before.
    const operator = await this.safeResolveOperator(toE164);

    // ── Unchanged production send path ──────────────────────────────────────
    // Identical to the pre-accounting behaviour: same provider, retries, and
    // logging. If this throws (delivery failed) we deliberately do NOT record a
    // row — accounting only reflects sends the gateway accepted. The returned
    // metadata is captured for persistence; a caller that ignores it is unaffected.
    //
    // The try/catch is OBSERVABILITY ONLY: the failure counter is incremented and
    // the original error is re-thrown unchanged, so BullMQ's retry/backoff and
    // every caller behave exactly as before.
    let result: SmsSendResult;
    try {
      result = await this.provider.send(toE164, text);
    } catch (err) {
      this.metrics?.recordSmsFailed(this.provider.name, template ?? null, err);
      throw err;
    }
    this.metrics?.recordSmsSent(this.provider.name, template ?? null);

    // Accounting is best-effort and MUST NOT change the send outcome: the SMS is
    // already accepted, so a persistence failure is logged and swallowed instead
    // of surfacing to the OTP flow.
    await this.recordAcceptedSms(toE164, operator, result, template ?? null);
  }

  /** Resolve the operator without ever throwing into the send path. */
  private async safeResolveOperator(
    toE164: string,
  ): Promise<ResolvedOperator | null> {
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
      // Defence in depth against a provider that hands back a non-integer
      // `parts` despite the SmsSendResult contract (Sayqal did exactly this,
      // returning the string "1"). Prisma's `parts Int?` rejects such a value
      // and the throw would discard the WHOLE accounting row — losing the
      // price snapshot the SMS cost metrics are summed from. A bad `parts` is
      // not worth that: coerce what we can, drop what we cannot.
      const parts =
        typeof result.parts === 'number'
          ? result.parts
          : Number.parseInt(String(result.parts), 10);

      await this.prisma.smsMessage.create({
        data: {
          provider: this.provider.name,
          providerTransactionId: result.providerTransactionId,
          providerSmsId: result.providerSmsId,
          parts: Number.isInteger(parts) ? parts : null,
          phoneE164: toE164,
          operatorId: operator?.operatorId ?? null,
          operatorName: operator?.operatorName ?? null,
          priceUzs: operator?.priceUzs ?? null,
          template,
          status: 'pending',
        },
      });
    } catch (err) {
      const prismaErr = err as {
        code?: string;
        meta?: unknown;
        message?: string;
        stack?: string;
      };
      this.logger.warn(
        `SMS accounting insert failed (send already succeeded): ${JSON.stringify(
          {
            message: prismaErr?.message ?? String(err),
            code: prismaErr?.code,
            meta: prismaErr?.meta,
            stack: prismaErr?.stack,
          },
        )}`,
      );
    }
  }

  /**
   * Apply an Eskiz delivery report to the accounting ledger.
   *
   * Closes the `pending` row that {@link recordAcceptedSms} inserted, flipping it
   * to delivered / failed / undelivered and stamping `deliveredAt` on success.
   *
   * Never throws. The caller answers Eskiz 200 in every case on purpose: a
   * non-2xx makes Eskiz redeliver the same report, and none of the failure modes
   * here (unknown id, unmapped status, DB blip) are fixed by a retry. The return
   * value reports what happened for logging and tests, not for the HTTP status.
   */
  async applyEskizCallback(payload: {
    messageId?: string | null;
    status?: string | null;
    error?: string | null;
  }): Promise<SmsCallbackOutcome> {
    const messageId = payload.messageId?.trim();
    if (!messageId) {
      this.logger.warn('Eskiz callback ignored: no message id in payload');
      return { outcome: 'ignored', reason: 'missing_message_id' };
    }

    const mapped = mapEskizStatus(payload.status);
    if (!mapped) {
      // Interim reports are expected and must NOT close the row; anything else
      // is a vocabulary we have not seen and is worth a louder log.
      if (isInterimStatus(payload.status)) {
        this.logger.log(
          `Eskiz callback for ${messageId}: interim status "${payload.status}" — leaving pending`,
        );
        return { outcome: 'ignored', reason: 'interim_status' };
      }
      this.logger.warn(
        `Eskiz callback for ${messageId}: unrecognised status "${payload.status}" — leaving pending`,
      );
      return { outcome: 'ignored', reason: 'unknown_status' };
    }

    try {
      // Scoped to provider='eskiz' so a providerSmsId that collides with another
      // aggregator's id can never rewrite the wrong row, and to status='pending'
      // so a duplicate report (Eskiz retries) is idempotent: the second delivery
      // of the same callback matches nothing and updates 0 rows.
      const { count } = await this.prisma.smsMessage.updateMany({
        where: { provider: 'eskiz', providerSmsId: messageId, status: 'pending' },
        data: {
          status: mapped,
          deliveredAt: mapped === 'delivered' ? new Date() : null,
          errorMessage: mapped === 'delivered' ? null : (payload.error ?? payload.status ?? null),
        },
      });

      if (count === 0) {
        // Either an id we never recorded, or a row already closed by an earlier
        // report. Both are benign — log and acknowledge.
        this.logger.log(
          `Eskiz callback for ${messageId}: no pending row matched (already closed or unknown id)`,
        );
        return { outcome: 'no_match', status: mapped };
      }

      this.logger.log(`Eskiz callback: ${messageId} → ${mapped}`);
      return { outcome: 'updated', status: mapped };
    } catch (err) {
      // A DB failure must not bounce the webhook: Eskiz would redeliver and hit
      // the same broken database. Swallow, log, and acknowledge.
      this.logger.error(
        `Eskiz callback for ${messageId} failed to persist: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { outcome: 'error' };
    }
  }
}
