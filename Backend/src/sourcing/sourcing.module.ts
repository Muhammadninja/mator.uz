import { Module } from '@nestjs/common';
import { SourcingService } from './sourcing.service';
import { SourcingOfferService } from './sourcing-offer.service';
import { AdminSourcingController } from './admin-sourcing.controller';
import { SourcingController } from './sourcing.controller';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CartModule } from '../cart/cart.module';
import { TelegramNotifierModule } from '../telegram/telegram-notifier.module';

/**
 * Sourcing-ticket persistence + the mator-admin operator console. PrismaModule
 * is global; AdminAuthModule is imported so AdminSourcingController can resolve
 * AdminJwtGuard/AdminRoleGuard (same wiring admin.module.ts uses).
 * NotificationsModule is imported so SourcingOfferService can deliver a seller's
 * offer to the requesting customer. Exports SourcingService (AiChatModule opens
 * tickets) and SourcingOfferService (the Telegram offer-DM flow records offers).
 */
@Module({
  imports: [AdminAuthModule, NotificationsModule, CartModule, TelegramNotifierModule],
  providers: [SourcingService, SourcingOfferService],
  controllers: [AdminSourcingController, SourcingController],
  exports: [SourcingService, SourcingOfferService],
})
export class SourcingModule {}
