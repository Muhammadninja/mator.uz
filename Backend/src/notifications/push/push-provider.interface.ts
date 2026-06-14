/** A single push message targeted at one device token. */
export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  deeplinkPath?: string | null;
}

/** Per-token delivery outcome. `DeviceNotRegistered` tokens get pruned upstream. */
export interface PushResult {
  token: string;
  ok: boolean;
  error?: 'DeviceNotRegistered' | 'InvalidCredentials' | 'Unknown';
}

export type PushChannel = 'expo' | 'fcm' | 'apns';

/** Pluggable transport for a single push channel (Expo / FCM / APNS). */
export interface PushProvider {
  readonly channel: PushChannel;
  send(messages: PushMessage[]): Promise<PushResult[]>;
}
