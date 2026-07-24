import { Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import { SmsProvider, SmsSendResult } from '../sms-provider.interface';

export interface SayqalConfig {
  baseUrl: string; // https://routee.sayqal.uz
  username: string;
  secretKey: string;
  serviceId: number;
  nickname?: string; // optional registered alpha-name (sender)
}

/** Shape of a successful /sms/TransmitSMS response (see Sayqal SMS API v2.0). */
interface SayqalSuccess {
  transactionid: string;
  smsid: string;
  parts: number;
}

/**
 * Shape of a Sayqal error body. The docs name the fields `errorCode`/`errorMsg`
 * but the worked example returns `errMsg`, so both spellings are read.
 */
interface SayqalError {
  errorCode?: number;
  errorMsg?: string;
  errMsg?: string;
}

const SEND_PATH = '/sms/TransmitSMS';
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries on transient (5xx / network) failures

/**
 * Sayqal Solutions (routee.sayqal.uz) SMS aggregator — single-recipient send.
 *
 * Auth is a per-request MD5 token in the `X-Access-Token` header, computed as
 * `md5("TransmitSMS {username} {secretKey} {utime}")` with the same `utime`
 * (UNIX seconds) that is sent in the body — the two MUST match or the gateway
 * returns 403. Because the token embeds a timestamp it is minted fresh on every
 * call rather than cached.
 *
 * Retries: transient failures (network errors, 5xx) are retried up to
 * {@link MAX_ATTEMPTS} times with backoff. Documented business errors (400/403)
 * are terminal and surface immediately as a descriptive Error.
 */
export class SayqalSmsProvider implements SmsProvider {
  readonly name = 'sayqal';
  private readonly logger = new Logger('SayqalSmsProvider');

  constructor(private readonly cfg: SayqalConfig) {}

  /** md5("TransmitSMS {username} {secretKey} {utime}") — per the API's token spec. */
  private buildToken(utime: number): string {
    const raw = `TransmitSMS ${this.cfg.username} ${this.cfg.secretKey} ${utime}`;
    return createHash('md5').update(raw).digest('hex');
  }

  private buildBody(utime: number, smsid: string, phone: string, text: string) {
    // service.nickname (alpha-name) is only sent when configured; the API treats
    // it as optional and we never fabricate a sender.
    const service: Record<string, unknown> = { service: this.cfg.serviceId };
    if (this.cfg.nickname) service.nickname = this.cfg.nickname;

    return {
      utime,
      username: this.cfg.username,
      service,
      message: { smsid, phone, text },
    };
  }

  private extractError(data: SayqalError | undefined): string {
    if (!data) return 'unknown error';
    const msg = data.errorMsg ?? data.errMsg ?? 'unknown error';
    return data.errorCode !== undefined ? `[${data.errorCode}] ${msg}` : msg;
  }

  async send(toE164: string, text: string): Promise<SmsSendResult> {
    // API expects 998YYXXXXXXX (12 digits, no '+'). Callers pass E.164 (+998...).
    const phone = toE164.replace(/\D/g, '');
    if (!/^998\d{9}$/.test(phone)) {
      throw new Error(`Sayqal: unsupported phone format "${toE164}" (expected 998XXXXXXXXX)`);
    }
    if (!text) {
      throw new Error('Sayqal: refusing to send an empty SMS body');
    }

    // Partner-side unique id, minted ONCE per logical send. It is intentionally
    // stable across retries: if a request reached the gateway but its response
    // was lost (timeout / 5xx from a proxy), retrying with the SAME smsid lets
    // Sayqal deduplicate instead of delivering — and billing — a second OTP.
    const smsid = randomUUID();
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}${SEND_PATH}`;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // utime must be current on each attempt (the gateway may reject a stale
      // timestamp) and MUST match between header token and body — both derive
      // from this single value.
      const utime = Math.floor(Date.now() / 1000);
      try {
        const res = await axios.post<SayqalSuccess>(
          url,
          this.buildBody(utime, smsid, phone, text),
          {
            headers: { 'X-Access-Token': this.buildToken(utime) },
            timeout: TIMEOUT_MS,
          },
        );
        this.logger.log(
          `Sayqal accepted sms transactionid=${res.data?.transactionid} parts=${res.data?.parts}`,
        );
        // Surface the gateway's own identifiers/parts for accounting. Read
        // straight from the response — never fabricated; `?? null` covers a
        // success body that omits a field.
        return {
          providerTransactionId: res.data?.transactionid ?? null,
          providerSmsId: res.data?.smsid ?? null,
          parts: res.data?.parts ?? null,
        };
      } catch (err) {
        lastErr = err;

        if (axios.isAxiosError(err)) {
          const status = err.response?.status;

          // 400 (invalid param) and 403 (bad token) are terminal per the docs —
          // retrying cannot help, so fail fast with the gateway's own message.
          if (status === 400 || status === 403) {
            const detail = this.extractError(err.response?.data as SayqalError);
            throw new Error(`Sayqal send rejected (HTTP ${status}): ${detail}`);
          }

          // 5xx / network / timeout → transient; retry with backoff.
          if (attempt < MAX_ATTEMPTS) {
            const backoffMs = 500 * attempt;
            this.logger.warn(
              `Sayqal send attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.message}); retrying in ${backoffMs}ms`,
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
        }

        // Non-axios error, or retries exhausted.
        break;
      }
    }

    const message =
      (axios.isAxiosError(lastErr) && lastErr.message) ||
      (lastErr instanceof Error ? lastErr.message : String(lastErr));
    this.logger.error(`Sayqal send failed after ${MAX_ATTEMPTS} attempt(s): ${message}`);
    throw new Error(`Sayqal SMS delivery failed: ${message}`);
  }
}
