import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { BookingStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateBookingDto } from './dto/create-booking.dto';

const HOLD_MINUTES = 5;

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(userId: string, providerId: string, dto: CreateBookingDto) {
    // Ownership: a caller may only attach their OWN vehicle to a booking.
    await this.assertOwnedVehicle(userId, dto.vehicle_id);

    const provider = await this.prisma.serviceProvider.findUnique({ where: { id: providerId } });
    if (!provider || !provider.isActive) throw new NotFoundException('Provider not found');

    const services = await this.prisma.providerServiceOffering.findMany({
      where: { id: { in: dto.service_ids }, providerId },
    });
    if (services.length !== dto.service_ids.length) {
      throw new BadRequestException('One or more service_ids are invalid for this provider');
    }

    const total = services.reduce((sum, s) => sum + Number(s.priceUzs), 0);
    const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);

    const booking = await this.prisma.booking.create({
      data: {
        id: prefixedId(IdPrefix.BOOKING),
        userId,
        providerId,
        vehicleId: dto.vehicle_id,
        status: BookingStatus.HOLD,
        scheduledAt: new Date(dto.scheduled_at),
        holdExpiresAt,
        totalUzs: total,
        notes: dto.notes,
        contactPhoneE164: dto.contact_phone_e164,
        services: {
          create: services.map((s) => ({
            id: prefixedId(IdPrefix.BOOKING_SERVICE),
            serviceId: s.id,
            name: s.name,
            priceUzs: s.priceUzs,
          })),
        },
      },
    });

    return {
      booking_id: booking.id,
      status: 'hold',
      hold_expires_at: holdExpiresAt.toISOString(),
      total_uzs: total,
      next_screen: 'CheckoutScreen',
    };
  }

  /**
   * Confirm a held booking (e.g. after checkout) → notifies the user.
   *
   * LOW-ORD-008: one conditional write decides it. The booking moves to
   * CONFIRMED only if it is still HOLD and its hold has not run out at this
   * moment, so neither a late confirm nor one racing the sweeper can revive an
   * expired hold: of the sweeper's HOLD → EXPIRED and this HOLD → CONFIRMED,
   * the database lets exactly one update the row. Re-confirming a booking that
   * is already CONFIRMED stays an idempotent success, as before.
   *
   * No payment is required here: the existing booking flow takes none, and
   * this change does not invent one.
   */
  async confirm(userId: string, bookingId: string) {
    const booking = await this.assertOwned(userId, bookingId);
    if (
      booking.status !== BookingStatus.HOLD &&
      booking.status !== BookingStatus.CONFIRMED
    ) {
      throw new BadRequestException('Booking can no longer be confirmed');
    }
    if (booking.status === BookingStatus.HOLD) {
      const now = new Date();
      const moved = await this.prisma.booking.updateMany({
        where: {
          id: bookingId,
          userId,
          status: BookingStatus.HOLD,
          OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: now } }],
        },
        data: { status: BookingStatus.CONFIRMED, holdExpiresAt: null },
      });
      if (moved.count === 0) {
        const current = await this.prisma.booking.findUnique({
          where: { id: bookingId },
          select: { status: true },
        });
        // A concurrent confirm of the same booking that got there first.
        if (current?.status !== BookingStatus.CONFIRMED) {
          throw new BadRequestException('Booking can no longer be confirmed');
        }
      }
    }

    await this.notifications.emit(userId, {
      type: NotificationType.BOOKING_CONFIRMED,
      title: 'Bandlov tasdiqlandi',
      body: 'Xizmat bandlovingiz tasdiqlandi. Belgilangan vaqtda tashrif buyuring.',
      data: { booking_id: bookingId },
      deeplinkPath: `/(tabs)/(services)/booking/${bookingId}`,
    });
    return { booking_id: bookingId, status: 'confirmed' };
  }

  /** Cancel a booking that has not yet completed → notifies the user. */
  async cancel(userId: string, bookingId: string) {
    const booking = await this.assertOwned(userId, bookingId);
    if (booking.status === BookingStatus.COMPLETED || booking.status === BookingStatus.CANCELLED) {
      throw new BadRequestException('Booking can no longer be cancelled');
    }
    // Conditional, like confirm: a booking that completed or was cancelled in
    // the meantime is not overwritten.
    const moved = await this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        status: { notIn: [BookingStatus.COMPLETED, BookingStatus.CANCELLED] },
      },
      data: { status: BookingStatus.CANCELLED, holdExpiresAt: null },
    });
    if (moved.count === 0) {
      throw new BadRequestException('Booking can no longer be cancelled');
    }

    await this.notifications.emit(userId, {
      type: NotificationType.BOOKING_CANCELLED,
      title: 'Bandlov bekor qilindi',
      body: 'Xizmat bandlovingiz bekor qilindi.',
      data: { booking_id: bookingId },
      deeplinkPath: `/(tabs)/(services)/booking/${bookingId}`,
    });
    return { booking_id: bookingId, status: 'cancelled' };
  }

  private async assertOwned(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.userId !== userId) throw new NotFoundException('Booking not found');
    return booking;
  }

  /** Ensure the referenced vehicle (if any) belongs to the caller. */
  private async assertOwnedVehicle(userId: string, vehicleId?: string): Promise<void> {
    if (!vehicleId) return;
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle || vehicle.userId !== userId || vehicle.deletedAt) {
      throw new NotFoundException('Vehicle not found');
    }
  }
}
