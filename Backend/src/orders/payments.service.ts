import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentProvider, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { CreateInvoiceDto } from './dto/create-invoice.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createPaymeInvoice(userId: string, dto: CreateInvoiceDto) {
    const order = await this.loadPayableOrder(userId, dto.order_id);
    const amountUzs = Number(order.totalUzs);
    const tiyin = Math.round(amountUzs * 100);
    const checkoutBase = this.config.get<string>('PAYME_CHECKOUT_URL') ?? 'https://checkout.paycom.uz';
    const deepLink = `payme://merchant/${order.id}?amount=${tiyin}`;
    const httpsFallback = `${checkoutBase}/c${order.id}`;

    const payment = await this.prisma.payment.create({
      data: {
        id: prefixedId(IdPrefix.PAYMENT),
        orderId: order.id,
        provider: PaymentProvider.PAYME,
        status: PaymentStatus.PENDING,
        amountUzs,
        amountTiyin: BigInt(tiyin),
        deepLink,
        httpsFallback,
        expiresAt: order.expiresAt,
      },
    });

    return {
      payment_id: payment.id,
      provider: 'payme',
      amount_tiyin: tiyin,
      amount_uzs: amountUzs,
      deep_link: deepLink,
      https_fallback: httpsFallback,
      expires_at: order.expiresAt ? order.expiresAt.toISOString() : null,
    };
  }

  async createClickInvoice(userId: string, dto: CreateInvoiceDto) {
    const order = await this.loadPayableOrder(userId, dto.order_id);
    const amountUzs = Number(order.totalUzs);
    const serviceId = this.config.get<string>('CLICK_SERVICE_ID') ?? '12345';
    const merchantId = this.config.get<string>('CLICK_MERCHANT_ID') ?? '67890';
    const returnUrl = dto.return_url ?? '';
    const base = `service_id=${serviceId}&merchant_id=${merchantId}&amount=${amountUzs}&transaction_param=${order.id}`;
    const deepLink = `click://services/pay?${base}&return_url=${encodeURIComponent(returnUrl)}`;
    const httpsFallback = `https://my.click.uz/services/pay?${base}`;

    const payment = await this.prisma.payment.create({
      data: {
        id: prefixedId(IdPrefix.PAYMENT),
        orderId: order.id,
        provider: PaymentProvider.CLICK,
        status: PaymentStatus.PENDING,
        amountUzs,
        deepLink,
        httpsFallback,
        expiresAt: order.expiresAt,
      },
    });

    return {
      payment_id: payment.id,
      provider: 'click',
      amount_uzs: amountUzs,
      deep_link: deepLink,
      https_fallback: httpsFallback,
      expires_at: order.expiresAt ? order.expiresAt.toISOString() : null,
    };
  }

  async getPayment(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!payment || payment.order.userId !== userId) {
      throw new NotFoundException('Payment not found');
    }
    return {
      payment_id: payment.id,
      provider: payment.provider.toLowerCase(),
      status: payment.status.toLowerCase(),
      paid_at: payment.paidAt ? payment.paidAt.toISOString() : null,
      provider_transaction_id: payment.providerTransactionId,
      order: {
        order_id: payment.orderId,
        status: payment.order.status.toLowerCase(),
        next_screen:
          payment.order.status === OrderStatus.PAID ? 'OrderConfirmationScreen' : null,
      },
    };
  }

  private async loadPayableOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Order is not awaiting payment');
    }
    return order;
  }
}
