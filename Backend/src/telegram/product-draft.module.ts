import { Module } from '@nestjs/common';
import { ProductDraftService } from './product-draft.service';
import { DraftCoordinator } from './draft-coordinator';
import { TelegramFileService } from './telegram-file.service';
import { ImageEnhanceService } from '../ai/image-enhance.service';

/**
 * Shared providers for the product-draft lifecycle. Kept as its own small module
 * (rather than living inside TelegramModule) so BOTH the Telegram side (wizard
 * orchestration + @OnEvent listeners) and the QueueModule (the image worker) can
 * import it without a Telegram↔Queue circular dependency.
 *
 * Provides:
 *   • ProductDraftService — thin draft data layer,
 *   • DraftCoordinator     — rendezvous/orchestration + domain events,
 *   • TelegramFileService  — file_id → download URL for the worker (download-only,
 *                            a standalone Telegram client; NOT the polling bot).
 *   • ImageEnhanceService  — the FLUX pipeline, shared by the worker (and, once
 *                            wired, TelegramService) instead of being new'd inline.
 *
 * Dependencies are all global (PrismaService, EventEmitter2, ConfigService).
 */
@Module({
  providers: [
    ProductDraftService,
    DraftCoordinator,
    TelegramFileService,
    ImageEnhanceService,
  ],
  exports: [
    ProductDraftService,
    DraftCoordinator,
    TelegramFileService,
    ImageEnhanceService,
  ],
})
export class ProductDraftModule {}
