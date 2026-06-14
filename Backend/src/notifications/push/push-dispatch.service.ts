import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExpoPushProvider } from './providers/expo.provider';
import { FcmPushProvider } from './providers/fcm.provider';
import { ApnsPushProvider } from './providers/apns.provider';
import { PushMessage, PushResult } from './push-provider.interface';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  deeplinkPath?: string | null;
}

/**
 * Fans a notification out to all of a user's registered devices, routing each
 * to the right transport by the token it carries (Expo first, then raw FCM /
 * APNS). Dead tokens reported by the providers are pruned so we stop targeting
 * uninstalled apps.
 */
@Injectable()
export class PushDispatchService {
  private readonly logger = new Logger(PushDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly expo: ExpoPushProvider,
    private readonly fcm: FcmPushProvider,
    private readonly apns: ApnsPushProvider,
  ) {}

  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    const devices = await this.prisma.device.findMany({ where: { userId } });
    if (!devices.length) return;

    const route: { expo: PushMessage[]; fcm: PushMessage[]; apns: PushMessage[] } = {
      expo: [],
      fcm: [],
      apns: [],
    };
    for (const d of devices) {
      const msg = (token: string): PushMessage => ({
        token,
        title: payload.title,
        body: payload.body,
        data: payload.data,
        deeplinkPath: payload.deeplinkPath,
      });
      if (d.expoPushToken) route.expo.push(msg(d.expoPushToken));
      else if (d.fcmToken) route.fcm.push(msg(d.fcmToken));
      else if (d.apnsToken) route.apns.push(msg(d.apnsToken));
    }

    const results = (
      await Promise.all([
        this.expo.send(route.expo),
        this.fcm.send(route.fcm),
        this.apns.send(route.apns),
      ])
    ).flat();

    await this.pruneDeadTokens(results);
  }

  private async pruneDeadTokens(results: PushResult[]): Promise<void> {
    const dead = results.filter((r) => r.error === 'DeviceNotRegistered').map((r) => r.token);
    if (!dead.length) return;
    this.logger.log(`Pruning ${dead.length} dead push token(s)`);
    await Promise.all([
      this.prisma.device.updateMany({ where: { expoPushToken: { in: dead } }, data: { expoPushToken: null } }),
      this.prisma.device.updateMany({ where: { fcmToken: { in: dead } }, data: { fcmToken: null } }),
      this.prisma.device.updateMany({ where: { apnsToken: { in: dead } }, data: { apnsToken: null } }),
    ]);
  }
}
