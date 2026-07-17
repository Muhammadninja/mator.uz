import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

/**
 * INTENTIONALLY INACTIVE — this module is not imported by AppModule, so none of
 * its `/api/products` routes are registered at runtime. It is kept for the
 * seller-side supply catalog work but is not part of the live buyer API.
 *
 * Before ever registering it: its routes are currently unauthenticated,
 * `getProductById` exposes seller phone/location, and the list `limit` is
 * unbounded. Add auth, remove seller PII from public projections, and clamp
 * pagination first (see the production security audit).
 */
@Module({
  imports: [PrismaModule],
  providers: [ProductsService],
  controllers: [ProductsController],
})
export class ProductsModule {}
