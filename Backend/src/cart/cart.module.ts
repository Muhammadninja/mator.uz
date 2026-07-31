import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { SalesModule } from '../sales/sales.module';
import { CartService } from './cart.service';
import { CartController } from './cart.controller';

@Module({
  // SalesModule exports DiscountService so cart line prices reflect active sales.
  imports: [PrismaModule, AuthModule, SalesModule],
  providers: [CartService],
  controllers: [CartController],
  exports: [CartService],
})
export class CartModule {}
