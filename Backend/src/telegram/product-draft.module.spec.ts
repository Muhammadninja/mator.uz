// Boot smoke for ProductDraftModule: proves its providers (ProductDraftService,
// DraftCoordinator, TelegramFileService, ImageEnhanceService) resolve together
// under Nest DI with only their real global deps (Prisma, EventEmitter2, Config)
// available. Guards the wiring the parallel flow depends on — and that both the
// Telegram side and the image worker import.

import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { ProductDraftModule } from './product-draft.module';
import { ProductDraftService } from './product-draft.service';
import { DraftCoordinator } from './draft-coordinator';
import { TelegramFileService } from './telegram-file.service';

// Global stub of the app-global PrismaService so ProductDraftModule's providers
// resolve without a real DB (its methods are not called in this wiring smoke).
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: {} }],
  exports: [PrismaService],
})
class StubPrismaModule {}

describe('ProductDraftModule (DI boot)', () => {
  it('resolves ProductDraftService, DraftCoordinator and TelegramFileService', async () => {
    // Env the constructors read at build time.
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.BFL_API_KEY = 'test-key';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        EventEmitterModule.forRoot(),
        StubPrismaModule,
        ProductDraftModule,
      ],
    }).compile();

    expect(moduleRef.get(ProductDraftService)).toBeInstanceOf(
      ProductDraftService,
    );
    expect(moduleRef.get(DraftCoordinator)).toBeInstanceOf(DraftCoordinator);
    expect(moduleRef.get(TelegramFileService)).toBeInstanceOf(
      TelegramFileService,
    );

    await moduleRef.close();
  });
});
