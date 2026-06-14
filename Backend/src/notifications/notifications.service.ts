import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma, type NotificationPreference } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { ListNotificationsQuery } from './dto/list-notifications.query';
import { presentNotification, presentPreferences } from './notification.presenter';
import { PushDispatchService } from './push/push-dispatch.service';

const DEFAULT_LIMIT = 20;

/** Notification type → preference flag that gates push delivery (absent = always on). */
const PREF_BY_TYPE: Partial<Record<NotificationType, keyof Pick<
  NotificationPreference,
  'orders' | 'payments' | 'aiReplies' | 'masterMessages' | 'marketing'
>>> = {
  [NotificationType.ORDER_PAID]: 'payments',
  [NotificationType.ORDER_STATUS_CHANGED]: 'orders',
  [NotificationType.PAYMENT_PAID]: 'payments',
  [NotificationType.AI_REPLY]: 'aiReplies',
  [NotificationType.MASTER_MESSAGE]: 'masterMessages',
  [NotificationType.BOOKING_CONFIRMED]: 'masterMessages',
  [NotificationType.BOOKING_CANCELLED]: 'masterMessages',
  [NotificationType.MARKETING]: 'marketing',
};

export interface EmitInput {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  deeplinkPath?: string | null;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushDispatchService,
  ) {}

  /**
   * Single funnel for system notifications: always persists the in-app inbox
   * row, then pushes to the user's devices when the category preference allows
   * and we're outside quiet hours. Push failures never propagate to the caller.
   */
  async emit(userId: string, input: EmitInput) {
    const notification = await this.prisma.notification.create({
      data: {
        id: prefixedId(IdPrefix.NOTIFICATION),
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data as object | undefined,
        deeplinkPath: input.deeplinkPath,
      },
    });

    try {
      if (await this.pushAllowed(userId, input.type)) {
        await this.push.sendToUser(userId, {
          title: input.title,
          body: input.body,
          deeplinkPath: input.deeplinkPath,
          data: { ...input.data, notification_id: notification.id, type: input.type.toLowerCase() },
        });
      }
    } catch (err) {
      this.logger.warn(`Push delivery failed for ${userId}: ${(err as Error).message}`);
    }

    return notification;
  }

  /** Paginated inbox (keyset by id) plus the live unread count. */
  async list(userId: string, query: ListNotificationsQuery) {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const where: Prisma.NotificationWhereInput = { userId };
    if (query.filter === 'unread') where.readAt = null;

    const rows = await this.prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const unreadCount = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });

    return {
      items: items.map(presentNotification),
      next_cursor: hasMore ? items[items.length - 1].id : null,
      unread_count: unreadCount,
    };
  }

  /** Mark one owned notification as read. Idempotent. */
  async markRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification || notification.userId !== userId) {
      throw new NotFoundException('Notification not found');
    }
    const updated = notification.readAt
      ? notification
      : await this.prisma.notification.update({
          where: { id: notificationId },
          data: { readAt: new Date() },
        });
    return presentNotification(updated);
  }

  /** Mark every unread notification for the user as read. */
  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  async getPreferences(userId: string) {
    return presentPreferences(await this.ensurePreferences(userId));
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    const data: {
      orders?: boolean;
      payments?: boolean;
      aiReplies?: boolean;
      masterMessages?: boolean;
      marketing?: boolean;
      quietHoursStart?: string;
      quietHoursEnd?: string;
    } = {};
    if (dto.orders !== undefined) data.orders = dto.orders;
    if (dto.payments !== undefined) data.payments = dto.payments;
    if (dto.ai_replies !== undefined) data.aiReplies = dto.ai_replies;
    if (dto.master_messages !== undefined) data.masterMessages = dto.master_messages;
    if (dto.marketing !== undefined) data.marketing = dto.marketing;
    if (dto.quiet_hours_start !== undefined) data.quietHoursStart = dto.quiet_hours_start;
    if (dto.quiet_hours_end !== undefined) data.quietHoursEnd = dto.quiet_hours_end;

    const pref = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        id: prefixedId(IdPrefix.NOTIFICATION_PREF),
        userId,
        ...data,
      },
      update: data,
    });
    return presentPreferences(pref);
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  /** A category may be muted by preference, and all push is suppressed during quiet hours. */
  private async pushAllowed(userId: string, type: NotificationType): Promise<boolean> {
    const pref = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    if (!pref) return true; // no prefs row yet → default allow
    const flag = PREF_BY_TYPE[type];
    if (flag && pref[flag] === false) return false;
    return !this.inQuietHours(pref);
  }

  /** Quiet hours are evaluated in Asia/Tashkent (UTC+5, no DST); supports overnight ranges. */
  private inQuietHours(pref: NotificationPreference): boolean {
    if (!pref.quietHoursStart || !pref.quietHoursEnd) return false;
    const tashkent = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const hhmm = `${String(tashkent.getUTCHours()).padStart(2, '0')}:${String(
      tashkent.getUTCMinutes(),
    ).padStart(2, '0')}`;
    const { quietHoursStart: start, quietHoursEnd: end } = pref;
    return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
  }

  private async ensurePreferences(userId: string) {
    const existing = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });
    if (existing) return existing;
    return this.prisma.notificationPreference.create({
      data: { id: prefixedId(IdPrefix.NOTIFICATION_PREF), userId },
    });
  }
}
