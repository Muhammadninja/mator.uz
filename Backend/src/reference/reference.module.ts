import { Module } from '@nestjs/common';
import { PartCategoryModule } from '../catalog/categories/part-category.module';
import { ReferenceService } from './reference.service';
import { ReferenceController } from './reference.controller';

/**
 * Buyer Reference API — read-only vehicle picker lookups plus the dynamic part
 * category tree the Telegram seller bot walks. PrismaService comes from the
 * global PrismaModule; no auth (public reference lists).
 */
@Module({
  imports: [PartCategoryModule],
  providers: [ReferenceService],
  controllers: [ReferenceController],
})
export class ReferenceModule {}
