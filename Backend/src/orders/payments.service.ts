import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { readPaymeConfig } from './webhooks/payme.config';
import { buildPaymeCheckoutUrl } from './webhooks/payme-checkout.util';
import { PaymeFiscalService } from './webhooks/payme-fiscal.service';
import { findOpenPaymeInvoice } from './webhooks/payme-invoice.util';
import { isPayableOrderStatus } from './order-transitions';
import {
  clickMerchantIds,
  isClickEnabled,
  isPaymeEnabled,
} from './webhooks/click.config';
import { assertReturnUrl, readReturnUrlPolicy } from './payment-return-url';
import { assertAllAvailable } from './order-availability';
import { findUnavailableForPayment } from './inventory/payment-availability';
import { OFFLINE_PAYMENT_TYPES } from './offline-order.policy';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fiscal: PaymeFiscalService,
  ) {}

  private returnUrl(dto: CreateInvoiceDto): string | undefined {
    return assertReturnUrl(
      dto.return_url,
      readReturnUrlPolicy((key) => this.config.get<string>(key)),
    );
  }

  async createPaymeInvoice(userId: string, dto: CreateInvoiceDto) {
    // A provider not listed in PAYMENT_PROVIDERS (e.g. a staging env with
    // `PAYMENT_PROVIDERS=`) hands out no checkout link and records no payment.
    if (!isPaymeEnabled((k) => this.config.get<string>(k))) {
      throw new BadRequestException('Payme payments are not enabled');
    }
    // Refused before anything is read or written for the order.
    const returnUrl = this.returnUrl(dto);
    const order = await this.loadPayableOrder(userId, dto.order_id);
    // Stock can change between placing the order and paying it: refuse a
    // checkout link for an order whose parts can no longer be sold.
    assertAllAvailable(
      await findUnavailableForPayment(this.prisma, order.id),
    );
    // Refuse BEFORE a checkout link exists. An order whose items lack fiscal
    // data (typically a dealer whose ИНН / ставка НДС is not configured yet)
    // must never reach Payme, and the customer should learn that here — while
    // paying is still just a button — rather than after being handed a link
    // that the webhook would then reject.
    const detail = await this.fiscal.buildOrderDetail(order.id);
    const amountUzs = Number(order.totalUzs);
    const tiyin = Math.round(amountUzs * 100);
    const payme = readPaymeConfig((key) => this.config.get<string>(key));
    const checkoutUrl = buildPaymeCheckoutUrl({
      merchantId: payme.merchantId,
      accountField: payme.accountField,
      orderId: order.id,
      amountTiyin: tiyin,
      checkoutBaseUrl: payme.checkoutUrl,
      returnUrl,
    });
    // Both fields carry the same official checkout link. The app opens it
    // directly; Payme's own page hands off to the installed Payme app.
    const deepLink = checkoutUrl;
    const httpsFallback = checkoutUrl;

    // The receipt is frozen here, because CheckPerformTransaction carries no transaction
    // id to hang it on. One open invoice per order, under the same lock CreateTransaction
    // takes: paying twice from two tapped buttons, or binding a transaction at this very
    // moment, cannot leave Payme holding one receipt and us another. A repeat tap reuses
    // the receipt already agreed and only refreshes the link, whose return_url may differ.
    const payment = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
      const open = await findOpenPaymeInvoice(tx, order.id);
      if (open) {
        return tx.payment.update({
          where: { id: open.id },
          data: { deepLink, httpsFallback },
        });
      }
      return tx.payment.create({
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
          fiscalSnapshot: {
            create: {
              detail: detail as unknown as Prisma.InputJsonObject,
              totalTiyin: BigInt(tiyin),
            },
          },
        },
      });
    });

    return {
      payment_id: payment.id,
      provider: 'payme',
      amount_tiyin: tiyin,
      amount_uzs: amountUzs,
      deep_link: deepLink,
      https_fallback: httpsFallback,
      expires_at: payment.expiresAt ? payment.expiresAt.toISOString() : null,
    };
  }

  async createClickInvoice(userId: string, dto: CreateInvoiceDto) {
    // A disabled provider (not listed, or no CLICK_SECRET_KEY) must not hand
    // out payment links whose callbacks the webhook would then refuse.
    if (!isClickEnabled((k) => this.config.get<string>(k))) {
      throw new BadRequestException('Click payments are not enabled');
    }
    // No placeholder ids: without the real ones a link would point at another
    // merchant's service. Boot validation refuses this state; this is the guard
    // for a process assembled without it.
    const ids = clickMerchantIds((k) => this.config.get<string>(k));
    if (!ids) {
      throw new BadRequestException('Click payments are not enabled');
    }
    const { serviceId, merchantId } = ids;
    const returnUrl = this.returnUrl(dto) ?? '';
    const order = await this.loadPayableOrder(userId, dto.order_id);
    const amountUzs = Number(order.totalUzs);
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
    if (!isPayableOrderStatus(order.status)) {
      throw new BadRequestException('Order is not awaiting payment');
    }
    // Paid in person and recorded by an operator: a second, online payment on the
    // same order would charge the customer twice.
    if (order.paymentType && OFFLINE_PAYMENT_TYPES.includes(order.paymentType)) {
      throw new ConflictException({
        code: 'OFFLINE_ORDER_NOT_PAYABLE_ONLINE',
        message: 'This order is paid in cash or by terminal, not online.',
      });
    }
    return order;
  }
}
