import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { FitmentStudioModule } from '../../src/admin/fitment-studio/fitment-studio.module';
import { FitmentQueueService } from '../../src/admin/fitment-studio/fitment-queue.service';
import { FitmentQueueController } from '../../src/admin/fitment-studio/fitment-queue.controller';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisModule } from '../../src/redis/redis.module';
import { RedisService } from '../../src/redis/redis.service';
import { createPrismaMock, fakeRedis, FakeQueueModule } from '../utils/harness';

/**
 * DI-graph boot check for FitmentStudioModule: FitmentQueueService now takes
 * the explicit business TOP-300 list through the FITMENT_TOP300_LIST token.
 * Proves the provider resolves in the real module (Prisma/Redis mocked).
 */
describe('FitmentStudioModule boot (e2e)', () => {
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        RedisModule,
        FakeQueueModule,
        FitmentStudioModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(createPrismaMock())
      .overrideProvider(RedisService)
      .useValue(fakeRedis())
      .compile();
  });

  afterAll(async () => {
    await mod?.close();
  });

  it('resolves the part-first queue with its TOP-300 list injected', async () => {
    expect(mod.get(FitmentQueueController)).toBeInstanceOf(
      FitmentQueueController,
    );
    const queue = mod.get(FitmentQueueService);
    // The shipped list is empty until the business supplies it: an explicit,
    // empty top300 — never a fallback to other parts.
    const res = await queue.getPartsQueue({ limit: 300, filter: 'top300' });
    expect(res.data).toEqual([]);
    expect(res.meta.top300?.listSize).toBe(0);
  });
});
