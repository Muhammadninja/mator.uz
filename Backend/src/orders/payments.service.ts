import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentProvider, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { readPaymeConfig } from './webhooks/payme.config';
import { buildPaymeCheckoutUrl } from './webhooks/payme-checkout.util';
import { PaymeFiscalService } from './webhooks/payme-fiscal.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fiscal: PaymeFiscalService,
  ) {}

  async createPaymeInvoice(userId: string, dto: CreateInvoiceDto) {
    const order = await this.loadPayableOrder(userId, dto.order_id);
    // Refuse BEFORE a checkout link exists. An order whose items lack fiscal
    // data (typically a dealer whose ИНН / ставка НДС is not configured yet)
    // must never reach Payme, and the customer should learn that here — while
    // paying is still just a button — rather than after being handed a link
    // that the webhook would then reject.
    await this.fiscal.assertFiscalizable(order.id);
    const amountUzs = Number(order.totalUzs);
    const tiyin = Math.round(amountUzs * 100);
    const payme = readPaymeConfig((key) => this.config.get<string>(key));
    const checkoutUrl = buildPaymeCheckoutUrl({
      merchantId: payme.merchantId,
      accountField: payme.accountField,
      orderId: order.id,
      amountTiyin: tiyin,
      checkoutBaseUrl: payme.checkoutUrl,
      returnUrl: dto.return_url,
    });
    // Both fields carry the same official checkout link. The app opens it
    // directly; Payme's own page hands off to the installed Payme app.
    const deepLink = checkoutUrl;
    const httpsFallback = checkoutUrl;

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
          payment.order.status === OrderStatus.PAID
            ? 'OrderConfirmationScreen'
            : null,
      },
    };
  }

  private async loadPayableOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order || order.userId !== userId)
      throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Order is not awaiting payment');
    }
    return order;
  }
}
