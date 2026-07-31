import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SalesModule } from '../sales/sales.module';
import { OrdersService } from './orders.service';
import { OrderStatusService } from './order-status.service';
import { OrdersController } from './orders.controller';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { SettlementService } from './webhooks/settlement.service';
import { PaymeService } from './webhooks/payme.service';
import { ClickService } from './webhooks/click.service';
import { PaymentWebhookController } from './webhooks/payment-webhook.controller';

@Module({
  // AdminAuthModule supplies the admin-token guards for the single operator
  // route (PATCH /v1/orders/:id/status). AuthModule stays: every other route
  // here is customer-facing and still authenticates with the app-user token.
  imports: [
    PrismaModule,
    AuthModule,
    AdminAuthModule,
    NotificationsModule,
    RealtimeModule,
    // Exports DiscountService so an order charges the active sale price.
    SalesModule,
  ],
  providers: [
    OrdersService,
    OrderStatusService,
    PaymentsService,
    SettlementService,
    PaymeService,
    ClickService,
  ],
  controllers: [OrdersController, PaymentsController, PaymentWebhookController],
  // Exported so the expiry cron (ProvidersModule) routes EXPIRED transitions
  // through the same single history-writing chokepoint.
  exports: [OrderStatusService],
})
export class OrdersModule {}
