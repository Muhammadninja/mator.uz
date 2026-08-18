import { Logger } from '@nestjs/common';
import axios from 'axios';
import { SmsProvider, SmsSendResult } from '../sms-provider.interface';

interface EskizConfig {
  baseUrl: string; // https://notify.eskiz.uz/api
  email: string;
  password: string;
  from?: string;
  /**
   * Public URL Eskiz posts delivery reports to (ESKIZ_CALLBACK_URL), e.g.
   * https://api.mator.uz/v1/sms/webhooks/eskiz. Omitted from the payload when
   * unset, so a deployment without a public address behaves exactly as before
   * and simply never receives reports.
   */
  callbackUrl?: string;
}

/**
 * Shape of a successful /message/sms/send response.
 *
 * Eskiz answers `200 OK` for BOTH accepted and rejected sends, so the body — not
 * the HTTP status — is the source of truth. An accepted send returns
 * `{ id: "...", status: "waiting", message: "Waiting for SMS provider" }`;
 * a rejected one returns the same 200 with `status: "error"` (or an omitted
 * `id`) and a human-readable `message`. `id` is typed `string | number` because
 * the gateway is documented as a string but has been observed sending a bare
 * number — it is normalised before it leaves this provider.
 */
interface EskizSendResponse {
  id?: string | number;
  status?: string;
  message?: string;
}

/** Shape of a successful /auth/login body: `{ data: { token } }`. */
interface EskizAuthResponse {
  data?: { token?: string };
}

const AUTH_PATH = '/auth/login';
const SEND_PATH = '/message/sms/send';
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries on transient (5xx / network) failures

/** Body-level `status` values Eskiz uses for an ACCEPTED send. */
const ACCEPTED_STATUSES = new Set([
  'waiting',
  'success',
  'ok',
  'sent',
  'delivered',
]);

/**
 * Normalise the gateway's message id into the `string | null` SmsSendResult
 * promises. A numeric id is stringified; anything empty or absent degrades to
 * null rather than a fabricated value.
 */
function toSmsId(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const id = String(raw).trim();
  return id.length > 0 ? id : null;
}

/**
 * Eskiz.uz aggregator. Auth is a bearer token obtained from email/password and
 * cached until it 401s, at which point it is transparently refreshed.
 *
 * Two failure modes are handled distinctly:
 *   - HTTP 401 → the cached token expired. Re-authenticate ONCE and replay the
 *     send. A parallel burst of 401s shares a single in-flight login (see
 *     {@link authenticate}) so the auth endpoint is never spammed.
 *   - HTTP 5xx / network / timeout → transient. Retried up to
 *     {@link MAX_ATTEMPTS} times with backoff.
 * Documented business errors (4xx other than 401) are terminal and surface
 * immediately, as does a `200 OK` whose body reports a rejection.
 */
export class EskizSmsProvider implements SmsProvider {
  readonly name = 'eskiz';
  private readonly logger = new Logger('EskizSmsProvider');
  private token?: string;
  /** In-flight login, shared by every concurrent caller. */
  private authInFlight?: Promise<string>;

  constructor(private readonly cfg: EskizConfig) {}

  private get baseUrl(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  /**
   * Obtain a bearer token, coalescing concurrent callers onto ONE request.
   *
   * With SMS_CONCURRENCY parallel workers a token expiry makes every in-flight
   * send 401 at once; without this guard each would fire its own /auth/login and
   * trip Eskiz's rate limit. The memo is cleared in a `finally` so a failed login
   * never poisons it — the next send retries cleanly.
   */
  private authenticate(): Promise<string> {
    if (this.authInFlight) return this.authInFlight;

    this.authInFlight = (async () => {
      const res = await axios.post<EskizAuthResponse>(
        `${this.baseUrl}${AUTH_PATH}`,
        { email: this.cfg.email, password: this.cfg.password },
        { timeout: TIMEOUT_MS },
      );
      const token = res.data?.data?.token;
      if (!token) throw new Error('Eskiz auth returned no token');
      this.token = token;
      this.logger.log('Eskiz auth token refreshed');
      return token;
    })().finally(() => {
      this.authInFlight = undefined;
    });

    return this.authInFlight;
  }

  /**
   * Validate the body of a `200 OK` and turn it into send metadata.
   *
   * Eskiz reports rejections (unmoderated template, bad sender, no balance) with
   * a 200, so trusting the HTTP status alone would mark an undelivered SMS as
   * sent and leave a `pending` accounting row that nothing can ever close.
   */
  private parseSendResponse(
    data: EskizSendResponse | undefined,
  ): SmsSendResult {
    const status = data?.status?.toLowerCase();
    const smsId = toSmsId(data?.id);

    // An explicit non-accepted status is a rejection, whatever the HTTP code.
    if (status && !ACCEPTED_STATUSES.has(status)) {
      throw new Error(
        `Eskiz send rejected (status="${data?.status}"): ${data?.message ?? 'no message'}`,
      );
    }

    // No id AND no recognised status means we cannot claim the gateway took it.
    if (!smsId && !status) {
      throw new Error(
        `Eskiz send returned no id or status: ${data?.message ?? 'empty response body'}`,
      );
    }

    // `parts` is not exposed by this endpoint — null, never fabricated. The SMS
    // cost metric falls back to the operator price snapshot.
    return { providerTransactionId: null, providerSmsId: smsId, parts: null };
  }

  async send(toE164: string, text: string): Promise<SmsSendResult> {
    const mobilePhone = toE164.replace(/\D/g, ''); // Eskiz expects digits only
    if (!/^998\d{9}$/.test(mobilePhone)) {
      throw new Error(
        `Eskiz: unsupported phone format "${toE164}" (expected 998XXXXXXXXX)`,
      );
    }
    if (!text) {
      throw new Error('Eskiz: refusing to send an empty SMS body');
    }

    const payload: Record<string, string> = {
      mobile_phone: mobilePhone,
      message: text,
      from: this.cfg.from ?? '4546',
    };
    // Only sent when configured: an absent ESKIZ_CALLBACK_URL must leave the
    // payload byte-identical to the pre-callback one, never an empty string that
    // the gateway could reject or try to POST to.
    if (this.cfg.callbackUrl) {
      payload.callback_url = this.cfg.callbackUrl;
    }
    const url = `${this.baseUrl}${SEND_PATH}`;

    const post = (token: string) =>
      axios.post<EskizSendResponse>(url, payload, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: TIMEOUT_MS,
      });

    let reauthorized = false; // at most one re-auth per logical send
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const token = this.token ?? (await this.authenticate());
        const res = await post(token);
        const result = this.parseSendResponse(res.data);
        this.logger.log(
          `Eskiz accepted sms id=${result.providerSmsId ?? 'n/a'}`,
        );
        return result;
      } catch (err) {
        lastErr = err;

        if (axios.isAxiosError(err)) {
          const status = err.response?.status;

          // Expired/invalid token: drop the cache, re-auth once, replay. This
          // does NOT consume a transient-retry attempt slot on its own — the
          // loop simply continues to the next iteration with a fresh token.
          if (status === 401 && !reauthorized) {
            reauthorized = true;
            this.token = undefined;
            this.logger.warn(
              'Eskiz returned 401 — re-authenticating and retrying the send',
            );
            try {
              await this.authenticate();
            } catch (authErr) {
              this.logger.error(
                `Eskiz re-authentication failed: ${(authErr as Error).message}`,
              );
              throw authErr;
            }
            continue;
          }

          // Terminal business errors (400 validation, 402 no balance, 403
          // forbidden sender, a second 401) — retrying cannot help.
          if (status !== undefined && status < 500) {
            const detail =
              (err.response?.data as EskizSendResponse | undefined)?.message ??
              err.message;
            this.logger.error(
              `Eskiz send rejected (HTTP ${status}): ${detail}`,
            );
            throw new Error(`Eskiz send rejected (HTTP ${status}): ${detail}`);
          }

          // 5xx / network / timeout → transient; retry with backoff.
          if (attempt < MAX_ATTEMPTS) {
            const backoffMs = 500 * attempt;
            this.logger.warn(
              `Eskiz send attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.message}); retrying in ${backoffMs}ms`,
            );
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
        }

        // Non-axios error (including a body-level rejection from
        // parseSendResponse), or retries exhausted.
        break;
      }
    }

    // An axios rejection is not guaranteed to be an Error instance, so read its
    // `message` before falling back to String() — otherwise a retry-exhausted
    // 5xx surfaces as "[object Object]" and the status code is lost to the logs.
    const message =
      (axios.isAxiosError(lastErr) && lastErr.message) ||
      (lastErr instanceof Error ? lastErr.message : String(lastErr));
    this.logger.error(
      `Eskiz send failed after ${MAX_ATTEMPTS} attempt(s): ${message}`,
    );
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Eskiz SMS delivery failed: ${message}`);
  }
}
