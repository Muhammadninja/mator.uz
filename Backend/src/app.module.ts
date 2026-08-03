import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validatePaymeEnv } from './orders/webhooks/payme.config';
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
import { AiChatModule } from './ai-chat/ai-chat.module';
import { SourcingModule } from './sourcing/sourcing.module';
import { EventsModule } from './events/events.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { UserModule } from './user/user.module';
import { AccountModule } from './account/account.module';
import { ShippingModule } from './shipping/shipping.module';
import { ReferenceModule } from './reference/reference.module';
import { AddressesModule } from './addresses/addresses.module';
import { DealersModule } from './dealers/dealers.module';
import { MobileConfigModule } from './mobile-config/mobile-config.module';
import { SalesModule } from './sales/sales.module';
import { OpsModule } from './ops/ops.module';
import { MetricsModule } from './metrics/metrics.module';
import { AlertingModule } from './alerting/alerting.module';
import { BlueprintModule } from './blueprint/blueprint.module';
import { isBlueprintEnabled } from './blueprint/blueprint-auth';

@Module({
  imports: [
    // `validate` runs before any provider is constructed, so a Payme
    // misconfiguration (missing merchant id/key, blank key, non-https checkout
    // URL) aborts bootstrap instead of exposing a webhook whose Basic auth
    // degrades to a publicly computable value. It also materialises the Payme
    // defaults; no other environment variable is inspected.
    ConfigModule.forRoot({ isGlobal: true, validate: validatePaymeEnv }),
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
    AiChatModule,
    SourcingModule,
    EventsModule,
    NotificationsModule,
    RealtimeModule,
    HealthModule,
    MobileConfigModule,
    UserModule,
    AccountModule,
    ShippingModule,
    ReferenceModule,
    AddressesModule,
    DealersModule,
    // Admin-managed automatic discounts (/v1/admin/sales, /v1/sales). Exports
    // DiscountService for products/cart/orders to inject; entirely separate
    // from the promo-code system, which is untouched.
    SalesModule,
    // Operations tooling (Bull Board, queue monitoring, alerts). Read-only with
    // respect to every existing flow — see ops.module.ts.
    OpsModule,
    // Internal alerting: rule evaluation every minute, Redis-backed dedupe,
    // Telegram delivery via BullMQ. Registered after OpsModule (whose
    // AlertService it bridges) and after MetricsModule (whose series the
    // latency/SMS rules read). Additive — see alerting.module.ts.
    AlertingModule,
    // 3D DB Blueprint — operator-only real-time schema visualizer. Mounted only
    // when enabled (off in production unless BLUEPRINT_ENABLED=true), so it adds
    // no attack surface by default. Spread evaluates to [] when disabled.
    ...(isBlueprintEnabled() ? [BlueprintModule] : []),
  ],
  // Bind ThrottlerGuard globally. Without this APP_GUARD registration the
  // ThrottlerModule config and every @Throttle/@SkipThrottle decorator across
  // the app are inert (no rate limiting is enforced). Registering it here
  // activates the global 100-req/min baseline and the per-route tightenings on
  // the auth/OTP endpoints.
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
