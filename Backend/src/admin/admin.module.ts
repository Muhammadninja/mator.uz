import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminOrdersService } from './orders/admin-orders.service';
import { AdminOrdersController } from './orders/admin-orders.controller';
import { SellersModule } from '../sellers/sellers.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, SellersModule, AuthModule],
  providers: [AdminService, AdminOrdersService],
  controllers: [AdminController, AdminOrdersController],
})
export class AdminModule {}
