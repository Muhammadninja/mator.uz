import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PartCategoryService } from './part-category.service';

/**
 * The dynamic category tree, packaged on its own so every consumer shares ONE
 * instance of the rules: the buyer catalog, the Reference API (seller bot), the
 * admin console, and the Telegram draft/commit path.
 *
 * Deliberately its own module rather than a member of CatalogModule — the
 * Reference and Telegram modules need the service but must not pull in the whole
 * buyer catalog (projection, search, sales), which would create import cycles.
 *
 * CacheService arrives via the @Global RedisModule, so it needs no import here.
 */
@Module({
  imports: [PrismaModule],
  providers: [PartCategoryService],
  exports: [PartCategoryService],
})
export class PartCategoryModule {}
