import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { SettlementService } from './webhooks/settlement.service';
import { PaymeService } from './webhooks/payme.service';
import { ClickService } from './webhooks/click.service';
import { PaymentWebhookController } from './webhooks/payment-webhook.controller';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  providers: [OrdersService, PaymentsService, SettlementService, PaymeService, ClickService],
  controllers: [OrdersController, PaymentsController, PaymentWebhookController],
})
export class OrdersModule {}
