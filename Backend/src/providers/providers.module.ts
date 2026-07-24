import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { ProvidersService } from './providers.service';
import { BookingsService } from './bookings.service';
import { BookingHoldSweeper } from './booking-sweeper.service';
import { MastersController } from './masters.controller';
import { StoController } from './sto.controller';
import { BookingsController } from './bookings.controller';

@Module({
  // OrdersModule exports OrderStatusService — the single order-status chokepoint
  // the expiry cron writes through.
  imports: [PrismaModule, AuthModule, NotificationsModule, OrdersModule],
  providers: [ProvidersService, BookingsService, BookingHoldSweeper],
  controllers: [MastersController, StoController, BookingsController],
})
export class ProvidersModule {}
