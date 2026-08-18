import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EskizWebhookController } from './eskiz-webhook.controller';
import { SmsService } from './sms.service';

// Boots a real Nest HTTP app around the controller so the ROUTE (path, verb,
// status code) and the per-route ValidationPipe are exercised end-to-end —
// a unit test on the class alone cannot catch a wiring mistake.
describe('POST /v1/sms/webhooks/eskiz (wiring)', () => {
  let app: INestApplication;
  const applyEskizCallback = jest
    .fn()
    .mockResolvedValue({ outcome: 'updated' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EskizWebhookController],
      providers: [{ provide: SmsService, useValue: { applyEskizCallback } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => await app.close());
  beforeEach(() => applyEskizCallback.mockClear());

  it('is reachable without any auth header and returns 200', async () => {
    await request(app.getHttpServer())
      .post('/v1/sms/webhooks/eskiz')
      .send({ message_id: 'msg-1', status: 'delivered' })
      .expect(200, { success: true });

    expect(applyEskizCallback).toHaveBeenCalledWith({
      messageId: 'msg-1',
      status: 'delivered',
      error: undefined,
    });
  });

  it('accepts unknown extra fields instead of 400-ing (Eskiz may add fields)', async () => {
    await request(app.getHttpServer())
      .post('/v1/sms/webhooks/eskiz')
      .send({
        message_id: 'msg-2',
        status: 'DELIVRD',
        totally_new_field: 'x',
        nested: { a: 1 },
      })
      .expect(200, { success: true });

    expect(applyEskizCallback).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-2', status: 'DELIVRD' }),
    );
  });

  it('still answers 200 on an empty body', async () => {
    await request(app.getHttpServer())
      .post('/v1/sms/webhooks/eskiz')
      .send({})
      .expect(200, { success: true });
  });
});
