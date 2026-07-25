import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { MetricsModule } from './metrics.module';
import { MetricsService } from './metrics.service';
import { DraftTelemetry } from '../telegram/draft-telemetry';

/**
 * Guards the one failure mode `@Optional()` instrumentation can hide.
 *
 * DraftTelemetry and SmsService take MetricsService as an OPTIONAL dependency so
 * the existing unit tests, which construct them by hand, keep compiling. The
 * cost of that choice is that a broken wiring does NOT crash at boot — Nest just
 * injects `undefined` and every business counter silently stays at zero, which
 * is exactly the kind of bug an observability layer must not have.
 *
 * So this asserts the property the optionality removes: inside a module graph
 * shaped like the real app's, MetricsService IS actually injected. It is the
 * counterpart to queue.module.di.spec.ts, which guards worker construction.
 */

/** Stands in for ProductDraftModule: a NON-global module providing DraftTelemetry. */
@Module({ providers: [DraftTelemetry], exports: [DraftTelemetry] })
class FakeProductDraftModule {}

/** A consumer in yet another module, like the image worker in QueueModule. */
@Injectable()
class FakeWorker {
  constructor(readonly telemetry: DraftTelemetry) {}
}

@Module({ imports: [FakeProductDraftModule], providers: [FakeWorker] })
class FakeQueueModule {}

const stubQueue = () => ({
  getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }),
  getWorkers: jest.fn().mockResolvedValue([]),
});

describe('MetricsService wiring across module boundaries', () => {
  it('injects MetricsService into DraftTelemetry even though ProductDraftModule never imports MetricsModule', async () => {
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MetricsModule.forRoot(),
        FakeQueueModule,
      ],
    });
    for (const name of Object.values(QUEUE_NAMES)) {
      builder.overrideProvider(getQueueToken(name)).useValue(stubQueue());
    }
    const moduleRef = await builder.compile();

    const telemetry = moduleRef.get(FakeWorker, { strict: false }).telemetry;
    const injected = (telemetry as unknown as { prom?: MetricsService }).prom;

    // If MetricsModule ever stops being @Global, this is what breaks — and it
    // would otherwise fail silently as permanently-zero business counters.
    expect(injected).toBeInstanceOf(MetricsService);
    expect(injected).toBe(moduleRef.get(MetricsService, { strict: false }));

    await moduleRef.close();
  });
});
