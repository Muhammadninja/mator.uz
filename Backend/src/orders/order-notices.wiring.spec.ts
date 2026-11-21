import 'reflect-metadata';
// The modules below import the auth stack, which loads `jose`, an ES module jest cannot
// require here. Nothing in this file verifies a token, so a stand-in is enough.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));
import type { InjectionToken } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AdminAuditService } from '../admin/auth/admin-audit.service';
import { AlertingModule } from '../alerting/alerting.module';
import { OrderNoticeService } from '../alerting/orders/order-notice.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { DiscountService } from '../sales/discount.service';
import { DeliveryQuoteService } from '../shipping/delivery-quote.service';
import { OrderNotices } from './order-notices';
import { OrderStatusService } from './order-status.service';
import { OrdersModule } from './orders.module';
import { OrdersService } from './orders.service';
import { SettlementService } from './webhooks/settlement.service';

// OrdersService and SettlementService take OrderNotices as @Optional (so unit tests can
// build them by hand). That also means a missing provider would not fail the boot: the
// operators would silently never hear of an order. This pins the wiring the container does.
describe('order notices wiring', () => {
  it('OrdersModule provides OrderNotices, and AlertingModule the service that sends it', () => {
    expect(Reflect.getMetadata('providers', OrdersModule)).toContain(
      OrderNotices,
    );
    expect(Reflect.getMetadata('providers', AlertingModule)).toContain(
      OrderNoticeService,
    );
  });

  it('the services that raise a notice are given the provided OrderNotices', async () => {
    const stub = (provide: InjectionToken) => ({ provide, useValue: {} });
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        SettlementService,
        OrderNotices,
        stub(PrismaService),
        { provide: ConfigService, useValue: { get: () => undefined } },
        stub(NotificationsService),
        stub(RealtimeGateway),
        stub(OrderStatusService),
        stub(DiscountService),
        stub(AdminAuditService),
        stub(DeliveryQuoteService),
      ],
    }).compile();

    const notices = moduleRef.get(OrderNotices);
    const injected = (service: unknown) =>
      (service as { orderNotices?: OrderNotices }).orderNotices;

    expect(injected(moduleRef.get(OrdersService))).toBe(notices);
    expect(injected(moduleRef.get(SettlementService))).toBe(notices);
    await moduleRef.close();
  });
});
