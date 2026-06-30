/**
 * Pluggable SMS transport. New aggregators implement this interface and are
 * registered in SmsService's provider map — no caller changes required.
 */
export interface SmsProvider {
  readonly name: string;
  send(toE164: string, text: string): Promise<void>;
}
