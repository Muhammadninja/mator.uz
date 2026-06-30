import type { Device } from '@prisma/client';

/** Maps a Device row to the contract's snake_case shape (platform lowercased). */
export function presentDevice(d: Device) {
  return {
    id: d.id,
    install_id: d.installId,
    platform: d.platform.toLowerCase(),
    expo_push_token: d.expoPushToken,
    fcm_token: d.fcmToken,
    apns_token: d.apnsToken,
    os_version: d.osVersion,
    app_version: d.appVersion,
    device_model: d.deviceModel,
    locale: d.locale,
    timezone: d.timezone,
    permissions_granted: d.permissionsGranted,
    last_seen_at: d.lastSeenAt.toISOString(),
    created_at: d.createdAt.toISOString(),
  };
}
