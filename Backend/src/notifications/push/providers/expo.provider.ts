import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushMessage, PushProvider, PushResult } from '../push-provider.interface';

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/**
 * Expo Push Service transport. For Expo-managed apps this is the primary
 * channel — Expo relays to FCM/APNS on our behalf, so only an Expo push token
 * is required. An optional EXPO_ACCESS_TOKEN authenticates enhanced security.
 */
@Injectable()
export class ExpoPushProvider implements PushProvider {
  readonly channel = 'expo' as const;
  private readonly logger = new Logger(ExpoPushProvider.name);
  private readonly accessToken?: string;

  constructor(config: ConfigService) {
    this.accessToken = config.get<string>('EXPO_ACCESS_TOKEN') || undefined;
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (!messages.length) return [];
    const payload = messages.map((m) => ({
      to: m.token,
      title: m.title,
      body: m.body,
      sound: 'default',
      priority: 'high',
      data: { ...m.data, deeplink: m.deeplinkPath ?? undefined },
    }));

    try {
      const res = await fetch(EXPO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const json: any = await res.json();
      const tickets: any[] = Array.isArray(json?.data) ? json.data : [];
      return messages.map((m, i) => this.mapTicket(m.token, tickets[i]));
    } catch (err) {
      this.logger.warn(`Expo push request failed: ${(err as Error).message}`);
      return messages.map((m) => ({ token: m.token, ok: false, error: 'Unknown' as const }));
    }
  }

  private mapTicket(token: string, ticket: any): PushResult {
    if (ticket?.status === 'ok') return { token, ok: true };
    const err = ticket?.details?.error;
    return {
      token,
      ok: false,
      error: err === 'DeviceNotRegistered' ? 'DeviceNotRegistered' : 'Unknown',
    };
  }
}
