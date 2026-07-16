import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SellersModule } from './sellers/sellers.module';
import { AdminModule } from './admin/admin.module';
import { TelegramModule } from './telegram/telegram.module';
import { GarageModule } from './garage/garage.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { RetentionModule } from './retention/retention.module';
import { CatalogModule } from './catalog/catalog.module';
import { CartModule } from './cart/cart.module';
import { OrdersModule } from './orders/orders.module';
import { ProvidersModule } from './providers/providers.module';
import { AiAdvisorModule } from './ai-advisor/ai-advisor.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { UserModule } from './user/user.module';
import { AccountModule } from './account/account.module';
import { ShippingModule } from './shipping/shipping.module';
import { ReferenceModule } from './reference/reference.module';
import { AddressesModule } from './addresses/addresses.module';
import { DealersModule } from './dealers/dealers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global baseline rate limit; sensitive auth routes tighten this further.
    ThrottlerModule.forRoot([{ ttl: 60 * 1000, limit: 100 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    SellersModule,
    AdminModule,
    TelegramModule,
    GarageModule,
    CloudinaryModule,
    RetentionModule,
    CatalogModule,
    CartModule,
    OrdersModule,
    ProvidersModule,
    AiAdvisorModule,
    NotificationsModule,
    RealtimeModule,
    HealthModule,
    UserModule,
    AccountModule,
    ShippingModule,
    ReferenceModule,
    AddressesModule,
    DealersModule,
  ],
})
export class AppModule {}
