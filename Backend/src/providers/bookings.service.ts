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
    const provider = await this.prisma.serviceProvider.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException('Provider not found');

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

  /** Confirm a held booking (e.g. after checkout) → notifies the user. */
  async confirm(userId: string, bookingId: string) {
    const booking = await this.assertOwned(userId, bookingId);
    if (booking.status !== BookingStatus.HOLD && booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException('Booking can no longer be confirmed');
    }
    if (booking.status === BookingStatus.HOLD) {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CONFIRMED, holdExpiresAt: null },
      });
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
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CANCELLED, holdExpiresAt: null },
    });

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
}
