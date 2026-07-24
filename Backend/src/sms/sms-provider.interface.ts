/**
 * Metadata a transport reports back about an accepted send. Fields are required
 * but nullable: a provider populates what its API exposes and returns `null` for
 * anything it does not (never a fabricated value). Consumers may ignore it.
 */
export interface SmsSendResult {
  providerTransactionId: string | null;
  providerSmsId: string | null;
  parts: number | null;
}

/** Shared result for providers/paths that expose no delivery metadata. */
export const EMPTY_SMS_RESULT: SmsSendResult = Object.freeze({
  providerTransactionId: null,
  providerSmsId: null,
  parts: null,
});

/**
 * Pluggable SMS transport. New aggregators implement this interface and are
 * registered in SmsService's provider map — no caller changes required.
 */
export interface SmsProvider {
  readonly name: string;
  send(toE164: string, text: string): Promise<SmsSendResult>;
}
