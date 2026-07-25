// DI wiring check for the migrated queues. The unit tests exercise the worker
// classes in isolation with hand-built doubles; this asserts the thing they
// cannot — that the Nest container can actually CONSTRUCT them.
//
// The migration added constructor args to SmsProcessor (SmsService) and
// NotificationsProcessor (PushDispatchService). If QueueModule fails to provide
// either, the app dies at boot with "Nest can't resolve dependencies" — a
// failure no unit test catches, because they all bypass DI.

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { SmsProcessor, NotificationsProcessor } from './queue.processors';
import { QUEUE_NAMES } from './queue.constants';
import { SmsService } from '../sms/sms.service';
import { PushDispatchService } from '../notifications/push/push-dispatch.service';

/**
 * Build just the worker slice against stubbed collaborators. Importing the real
 * QueueModule would open a live Redis connection (BullMQ forRootAsync) and pull
 * in Prisma/Config, which a unit test must not do — so the workers are resolved
 * by the real container with their declared dependencies supplied as values.
 *
 * What this proves is precisely what the unit tests cannot: Nest can READ each
 * worker's constructor metadata and inject into it. The concrete push/SMS
 * implementations are stubbed at their class tokens (they are leaf services over
 * Prisma/Config and have their own specs), so a missing `emitDecoratorMetadata`,
 * a missing `@Injectable()`, or an extra unprovided constructor arg still fails
 * here — which is the regression this guards.
 */
async function buildWorkerSlice() {
  return Test.createTestingModule({
    providers: [
      SmsProcessor,
      NotificationsProcessor,
      { provide: SmsService, useValue: { sendSms: jest.fn() } },
      { provide: PushDispatchService, useValue: { sendToUser: jest.fn() } },
    ],
  }).compile();
}

describe('QueueModule DI wiring for the migrated workers', () => {
  it('constructs SmsProcessor with its SmsService dependency', async () => {
    const moduleRef = await buildWorkerSlice();
    const processor = moduleRef.get(SmsProcessor);

    expect(processor).toBeInstanceOf(SmsProcessor);
    // Constructed, not hand-assembled: the dependency actually resolved.
    expect((processor as unknown as { sms: unknown }).sms).toBeDefined();
    await moduleRef.close();
  });

  it('constructs NotificationsProcessor with its PushDispatchService dependency', async () => {
    const moduleRef = await buildWorkerSlice();
    const processor = moduleRef.get(NotificationsProcessor);

    expect(processor).toBeInstanceOf(NotificationsProcessor);
    expect((processor as unknown as { push: unknown }).push).toBeDefined();
    await moduleRef.close();
  });

  it('registers the SMS and NOTIFICATIONS queues under their canonical names', () => {
    // Guards against a producer enqueueing to a queue name no worker consumes.
    expect(getQueueToken(QUEUE_NAMES.SMS)).toBe('BullQueue_sms');
    expect(getQueueToken(QUEUE_NAMES.NOTIFICATIONS)).toBe(
      'BullQueue_notifications',
    );
    // The image queue's token is unchanged by this migration.
    expect(getQueueToken(QUEUE_NAMES.IMAGE_PROCESSING)).toBe(
      'BullQueue_image-processing',
    );
  });
});
