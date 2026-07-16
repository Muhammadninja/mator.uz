import { Module } from '@nestjs/common';
import { ReferenceService } from './reference.service';
import { ReferenceController } from './reference.controller';

/**
 * Buyer Reference API — read-only vehicle picker lookups. PrismaService comes
 * from the global PrismaModule; no auth (public reference lists).
 */
@Module({
  providers: [ReferenceService],
  controllers: [ReferenceController],
})
export class ReferenceModule {}
