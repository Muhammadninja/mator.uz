import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminOrdersService } from './orders/admin-orders.service';
import { AdminOrdersController } from './orders/admin-orders.controller';
import { AdminUsersService } from './users/admin-users.service';
import { AdminUsersController } from './users/admin-users.controller';
import { AdminDealersService } from './dealers/admin-dealers.service';
import { AdminDealersController } from './dealers/admin-dealers.controller';
import { AdminBrandsService } from './brands/admin-brands.service';
import { AdminBrandsController } from './brands/admin-brands.controller';
import { AdminModelsController } from './brands/admin-models.controller';
import { AdminCategoriesService } from './categories/admin-categories.service';
import { AdminCategoriesController } from './categories/admin-categories.controller';
import { AdminProductsController } from './categories/admin-products.controller';
import { AdminInventoryService } from './inventory/admin-inventory.service';
import { AdminInventoryController } from './inventory/admin-inventory.controller';
import { SellersModule } from '../sellers/sellers.module';
import { AuthModule } from '../auth/auth.module';
import { AdminAuthModule } from './auth/admin-auth.module';
import { AdminManagementModule } from './management/admin-management.module';
import { FitmentStudioModule } from './fitment-studio/fitment-studio.module';

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
    FitmentStudioModule,
  ],
  // AdminDealersService takes AdminAuditService, which AdminAuthModule exports.
  // AdminBrandsService takes CacheService from the @Global RedisModule (no
  // import needed) to bust the reference catalog cache on every write.
  providers: [
    AdminService,
    AdminOrdersService,
    AdminUsersService,
    AdminDealersService,
    AdminBrandsService,
    AdminCategoriesService,
    AdminInventoryService,
  ],
  controllers: [
    AdminController,
    AdminOrdersController,
    AdminUsersController,
    AdminDealersController,
    AdminBrandsController,
    AdminModelsController,
    AdminCategoriesController,
    AdminProductsController,
    AdminInventoryController,
  ],
})
export class AdminModule {}
