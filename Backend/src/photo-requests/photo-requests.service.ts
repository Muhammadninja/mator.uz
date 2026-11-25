import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType, PhotoRequestStatus, Prisma } from '@prisma/client';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramNotifierService } from '../telegram/telegram-notifier.service';
import { photoAddedCopy } from './photo-request.copy';

export type PhotoRequestOutcome =
  | { kind: 'REQUESTED'; partId: string; partTitle: string }
  | { kind: 'ALREADY_AVAILABLE'; partId: string; partTitle: string }
  | { kind: 'NOT_FOUND' };

const BATCH = 50;
/** Give the send made at request time a head start before the sweep retries it. */
const STAFF_RETRY_AFTER_MS = 2 * 60_000;
const MAX_STAFF_ATTEMPTS = 5;

/**
 * Photo requests from Mator AI: a customer looking at a part with no photo
 * asks for one. Staff get a Telegram card; once the part has a photo, by any
 * path (the admin photo console, the seller bot, an integration), the sweep
 * notifies everyone who asked and links them back to the part.
 */
@Injectable()
export class PhotoRequestsService {
  private readonly logger = new Logger(PhotoRequestsService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramNotifierService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The part a photo would be asked for, and whether it already shows one. */
  async lookup(
    partId: string,
  ): Promise<{ id: string; title: string; hasPhoto: boolean } | null> {
    const part = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      select: { id: true, title: true, images: true },
    });
    return part ? { id: part.id, title: part.title, hasPhoto: part.images.length > 0 } : null;
  }

  /** Record the request. Asking again while one is open changes nothing. */
  async request(userId: string, partId: string): Promise<PhotoRequestOutcome> {
    const part = await this.lookup(partId);
    if (!part) return { kind: 'NOT_FOUND' };
    if (part.hasPhoto) {
      return { kind: 'ALREADY_AVAILABLE', partId: part.id, partTitle: part.title };
    }

    const existing = await this.prisma.photoRequest.findUnique({
      where: { userId_partId: { userId, partId } },
      select: { status: true },
    });
    if (existing?.status === PhotoRequestStatus.PENDING) {
      return { kind: 'REQUESTED', partId: part.id, partTitle: part.title };
    }

    // New, or fulfilled earlier and the photos have since been removed.
    const fresh = {
      partTitle: part.title,
      status: PhotoRequestStatus.PENDING,
      staffNotifiedAt: null,
      staffNotifyAttempts: 0,
      fulfilledAt: null,
    };
    let id: string;
    try {
      ({ id } = await this.prisma.photoRequest.upsert({
        where: { userId_partId: { userId, partId } },
        create: { userId, partId, ...fresh },
        update: fresh,
        select: { id: true },
      }));
    } catch (err) {
      // A concurrent ask for the same part created it first: that one stands.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { kind: 'REQUESTED', partId: part.id, partTitle: part.title };
      }
      throw err;
    }

    // Not awaited: Telegram must not hold up the reply. The sweep retries.
    void this.notifyStaff(id).catch((err: unknown) =>
      this.logger.warn(`Photo request ${id} staff card will retry: ${errorText(err)}`),
    );
    return { kind: 'REQUESTED', partId: part.id, partTitle: part.title };
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'photo-requests', timeZone: 'UTC' })
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const step of [() => this.retryStaffCards(), () => this.fulfilReady()]) {
        await step().catch((err: unknown) =>
          this.logger.error(`Photo request sweep step failed: ${errorText(err)}`),
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** Send the staff card for one request, recording the attempt first. */
  async notifyStaff(id: string): Promise<void> {
    const claimed = await this.prisma.photoRequest.updateMany({
      where: {
        id,
        status: PhotoRequestStatus.PENDING,
        staffNotifiedAt: null,
        staffNotifyAttempts: { lt: MAX_STAFF_ATTEMPTS },
      },
      data: { staffNotifyAttempts: { increment: 1 } },
    });
    if (claimed.count === 0) return;

    const row = await this.prisma.photoRequest.findUnique({
      where: { id },
      select: { partId: true, partTitle: true },
    });
    if (!row) return;
    const waiting = await this.prisma.photoRequest.count({
      where: { partId: row.partId, status: PhotoRequestStatus.PENDING },
    });
    const result = await this.telegram.sendPhotoRequest({ ...row, waiting });
    if (result.ok) {
      await this.prisma.photoRequest.update({
        where: { id },
        data: { staffNotifiedAt: new Date() },
      });
    }
  }

  private async retryStaffCards(): Promise<void> {
    const due = await this.prisma.photoRequest.findMany({
      where: {
        status: PhotoRequestStatus.PENDING,
        staffNotifiedAt: null,
        staffNotifyAttempts: { lt: MAX_STAFF_ATTEMPTS },
        updatedAt: { lte: new Date(Date.now() - STAFF_RETRY_AFTER_MS) },
      },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of due) await this.notifyStaff(id);
  }

  /** Every open request whose part now shows a photo: tell the customer. */
  async fulfilReady(): Promise<void> {
    const ready = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT pr.id
      FROM photo_requests pr
      JOIN catalog_parts cp ON cp.id = pr.part_id
      WHERE pr.status = 'PENDING' AND cardinality(cp.images) > 0
      ORDER BY pr.created_at
      LIMIT ${BATCH}`;
    for (const { id } of ready) {
      const claimed = await this.prisma.photoRequest.updateMany({
        where: { id, status: PhotoRequestStatus.PENDING },
        data: { status: PhotoRequestStatus.FULFILLED, fulfilledAt: new Date() },
      });
      if (claimed.count === 0) continue;

      const row = await this.prisma.photoRequest.findUnique({
        where: { id },
        select: { userId: true, partId: true, partTitle: true, user: { select: { language: true } } },
      });
      if (!row) continue;
      try {
        await this.notifications.emit(row.userId, {
          type: NotificationType.PRODUCT_PHOTO_ADDED,
          ...photoAddedCopy(row.user.language, row.partTitle),
          data: { photoRequestId: id, partId: row.partId, partName: row.partTitle },
          deeplinkPath: `/item-detail/${row.partId}`,
        });
      } catch (err) {
        // Put it back so the next sweep tries again.
        await this.prisma.photoRequest.updateMany({
          where: { id, status: PhotoRequestStatus.FULFILLED },
          data: { status: PhotoRequestStatus.PENDING, fulfilledAt: null },
        });
        this.logger.warn(`Photo-added notice for ${id} will retry: ${errorText(err)}`);
      }
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
