import { Injectable, NotFoundException } from '@nestjs/common';
import { DevicePlatform, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { presentDevice } from './device.presenter';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register or refresh a push device. Idempotent on (user, install_id): a repeat
   * call from the same install updates tokens/metadata instead of duplicating.
   */
  async register(userId: string, dto: RegisterDeviceDto) {
    const shared = {
      platform: dto.platform.toUpperCase() as DevicePlatform,
      expoPushToken: dto.expo_push_token ?? null,
      fcmToken: dto.fcm_token ?? null,
      apnsToken: dto.apns_token ?? null,
      osVersion: dto.os_version ?? null,
      appVersion: dto.app_version ?? null,
      deviceModel: dto.device_model ?? null,
      locale: dto.locale ?? null,
      timezone: dto.timezone ?? null,
      permissionsGranted: dto.permissions_granted ?? false,
      lastSeenAt: new Date(),
    } satisfies Partial<Prisma.DeviceUncheckedCreateInput>;

    const device = await this.prisma.device.upsert({
      where: { userId_installId: { userId, installId: dto.install_id } },
      create: {
        id: dto.device_id ?? prefixedId(IdPrefix.DEVICE),
        userId,
        installId: dto.install_id,
        ...shared,
      },
      update: shared,
    });

    return presentDevice(device);
  }

  async list(userId: string) {
    const devices = await this.prisma.device.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return { items: devices.map(presentDevice) };
  }

  /** Unbind a device the caller owns. Deleting clears its push tokens too. */
  async unregister(userId: string, deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== userId) {
      throw new NotFoundException('Device not found');
    }
    await this.prisma.device.delete({ where: { id: deviceId } });
  }
}
