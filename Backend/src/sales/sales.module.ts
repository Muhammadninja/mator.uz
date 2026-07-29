import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { AdminSalesController } from './admin-sales.controller';
import { DiscountService } from './discount.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/**
 * Sales — admin-managed automatic discounts. Entirely separate from the
 * promo-code system: a promo code is typed by the buyer and discounts a cart,
 * a sale is created in the admin panel and discounts a product with no user
 * input. They share no table and no code path.
 *
 * Two surfaces:
 *   • /v1/admin/sales — CRUD, admin-token + role gated (AdminAuthModule supplies
 *     the AdminJwtGuard strategy the controller binds to).
 *   • /v1/sales       — public, read-only, active sales only.
 *
 * DiscountService is EXPORTED so products, cart and orders can inject it and
 * price against the same engine. That is the intended integration point: no
 * consumer should re-implement discount arithmetic or scope resolution, and
 * none needs to import anything else from this module.
 *
 * PrismaService comes from the global PrismaModule.
 */
@Module({
  imports: [AdminAuthModule],
  providers: [SalesService, DiscountService],
  controllers: [AdminSalesController, SalesController],
  exports: [DiscountService],
})
export class SalesModule {}
