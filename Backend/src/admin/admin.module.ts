import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminOrdersService } from './orders/admin-orders.service';
import { AdminOrdersController } from './orders/admin-orders.controller';
import { SellersModule } from '../sellers/sellers.module';
import { AuthModule } from '../auth/auth.module';
import { AdminAuthModule } from './auth/admin-auth.module';

@Module({
  // AdminAuthModule is additive: it brings the admin-panel login stack
  // (/v1/auth/admin/*). AuthModule stays for the existing mobile-token-gated
  // admin order endpoints, which are unchanged.
  imports: [PrismaModule, SellersModule, AuthModule, AdminAuthModule],
  providers: [AdminService, AdminOrdersService],
  controllers: [AdminController, AdminOrdersController],
})
export class AdminModule {}
