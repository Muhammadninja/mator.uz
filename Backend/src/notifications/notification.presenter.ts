import type { Notification, NotificationPreference } from '@prisma/client';

/** Maps a Notification row to the contract's snake_case shape. */
export function presentNotification(n: Notification) {
  return {
    id: n.id,
    type: n.type.toLowerCase(),
    title: n.title,
    body: n.body,
    data: n.data ?? null,
    deeplink_path: n.deeplinkPath,
    read: n.readAt !== null,
    read_at: n.readAt ? n.readAt.toISOString() : null,
    created_at: n.createdAt.toISOString(),
  };
}

/** Maps the per-user preference row to the contract shape. */
export function presentPreferences(p: NotificationPreference) {
  return {
    orders: p.orders,
    payments: p.payments,
    ai_replies: p.aiReplies,
    master_messages: p.masterMessages,
    marketing: p.marketing,
    quiet_hours_start: p.quietHoursStart,
    quiet_hours_end: p.quietHoursEnd,
    updated_at: p.updatedAt.toISOString(),
  };
}
