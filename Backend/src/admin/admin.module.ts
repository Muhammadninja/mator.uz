import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminOrdersService } from './orders/admin-orders.service';
import { AdminOrdersController } from './orders/admin-orders.controller';
import { AdminUsersService } from './users/admin-users.service';
import { AdminUsersController } from './users/admin-users.controller';
import { SellersModule } from '../sellers/sellers.module';
import { AuthModule } from '../auth/auth.module';
import { AdminAuthModule } from './auth/admin-auth.module';
import { AdminManagementModule } from './management/admin-management.module';

@Module({
  // AdminAuthModule brings the admin-panel login stack (/v1/auth/admin/*) and
  // the guards used by the /v1/admin/* consoles. AuthModule stays for the
  // legacy app-user-token-gated /api/admin/sellers/* routes on AdminController.
  imports: [
    PrismaModule,
    SellersModule,
    AuthModule,
    AdminAuthModule,
    AdminManagementModule,
  ],
  providers: [AdminService, AdminOrdersService, AdminUsersService],
  controllers: [AdminController, AdminOrdersController, AdminUsersController],
})
export class AdminModule {}
