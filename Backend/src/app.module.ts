import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
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
import { OpsModule } from './ops/ops.module';
import { MetricsModule } from './metrics/metrics.module';
import { AlertingModule } from './alerting/alerting.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global baseline rate limit; sensitive auth routes tighten this further.
    ThrottlerModule.forRoot([{ ttl: 60 * 1000, limit: 100 }]),
    ScheduleModule.forRoot(),
    // In-process domain events. Used to decouple the image worker from Telegram:
    // DraftCoordinator emits draft.* events; TelegramService reacts (@OnEvent).
    EventEmitterModule.forRoot(),
    PrismaModule,
    RedisModule,
    QueueModule,
    // Prometheus metrics (/metrics). Global + additive: it exposes counters for
    // work the app already does and changes no existing flow — see
    // metrics.module.ts. Registered after QueueModule so the BullMQ root
    // connection exists when it re-registers the queues for read-only sampling.
    MetricsModule.forRoot(),
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
    // Operations tooling (Bull Board, queue monitoring, alerts). Read-only with
    // respect to every existing flow — see ops.module.ts.
    OpsModule,
    // Internal alerting: rule evaluation every minute, Redis-backed dedupe,
    // Telegram delivery via BullMQ. Registered after OpsModule (whose
    // AlertService it bridges) and after MetricsModule (whose series the
    // latency/SMS rules read). Additive — see alerting.module.ts.
    AlertingModule,
  ],
  // Bind ThrottlerGuard globally. Without this APP_GUARD registration the
  // ThrottlerModule config and every @Throttle/@SkipThrottle decorator across
  // the app are inert (no rate limiting is enforced). Registering it here
  // activates the global 100-req/min baseline and the per-route tightenings on
  // the auth/OTP endpoints.
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
