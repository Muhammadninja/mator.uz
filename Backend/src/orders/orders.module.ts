import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SalesModule } from '../sales/sales.module';
import { ShippingModule } from '../shipping/shipping.module';
import { OrdersService } from './orders.service';
import { OrderStatusService } from './order-status.service';
import { OfflineOrderMonitorService } from './offline-order-monitor.service';
import { OrdersController } from './orders.controller';
import { OfflineCollectionService } from './offline-collection.service';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { SettlementService } from './webhooks/settlement.service';
import { PaymeService } from './webhooks/payme.service';
import { PaymeFiscalService } from './webhooks/payme-fiscal.service';
import { PaymeFiscalReceiptService } from './webhooks/payme-fiscal-receipt.service';
import { ClickService } from './webhooks/click.service';
import { PaymentWebhookController } from './webhooks/payment-webhook.controller';
import { FinanceAlerts } from './finance-alerts';

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
    // Exports DeliveryQuoteService so an order charges what a quote computes.
    ShippingModule,
  ],
  providers: [
    OrdersService,
    OfflineCollectionService,
    OrderStatusService,
    OfflineOrderMonitorService,
    PaymentsService,
    SettlementService,
    PaymeService,
    // The fiscal-receipt builder: the checkout gate, and the receipt each invoice
    // freezes for the webhook's CheckPerformTransaction reply (PaymentsService).
    PaymeFiscalService,
    PaymeFiscalReceiptService,
    ClickService,
    // Fiscal and refund failures for a person to take up (see finance-alerts.ts).
    FinanceAlerts,
  ],
  controllers: [OrdersController, PaymentsController, PaymentWebhookController],
  // Exported so the expiry cron (ProvidersModule) routes EXPIRED transitions
  // through the same single history-writing chokepoint.
  exports: [OrderStatusService],
})
export class OrdersModule {}
