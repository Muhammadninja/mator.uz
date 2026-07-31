/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * HTTP-level checks for the Payme webhook route.
 *
 * These exist because the protocol constraints live in the transport layer, not
 * the service: Payme requires HTTP 200 for every outcome, and a malformed body
 * must come back as JSON-RPC -32700 rather than the framework's HTTP 400. That
 * behaviour depends on the raw-body middleware being wired ahead of the global
 * JSON parser, which only a real request exercises.
 */
import express from 'express';
import request from 'supertest';
import {
  PAYME_WEBHOOK_PATH,
  paymeRawBodyMiddleware,
} from '../../src/orders/webhooks/payme-raw-body.middleware';

const KEY = 'merchant-secret';
const AUTH = 'Basic ' + Buffer.from(`Paycom:${KEY}`).toString('base64');

describe('Payme webhook transport', () => {
  let app: express.Express;
  let handleRaw: jest.Mock;

  beforeEach(() => {
    handleRaw = jest.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { allow: true } });

    app = express();
    // Same order as main.ts: the Payme raw-body capture runs BEFORE the global
    // JSON parser, so a syntax error never reaches express.json().
    app.use(PAYME_WEBHOOK_PATH, paymeRawBodyMiddleware);
    app.use(express.json());
    app.post(PAYME_WEBHOOK_PATH, (req, res) => {
      void (async () => {
        res.status(200).json(await handleRaw(req.headers.authorization, req.body));
      })();
    });
  });

  it('passes a well-formed body through as raw text', async () => {
    const body = { id: 1, method: 'CheckPerformTransaction', params: {} };
    const res = await request(app).post(PAYME_WEBHOOK_PATH).set('Authorization', AUTH).send(body);

    expect(res.status).toBe(200);
    // The handler receives the raw string, not a pre-parsed object.
    expect(handleRaw).toHaveBeenCalledWith(AUTH, JSON.stringify(body));
  });

  it('answers HTTP 200 for a malformed body instead of the framework 400', async () => {
    handleRaw.mockResolvedValue({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: { ru: 'x', uz: 'x', en: 'x' } },
    });

    const res = await request(app)
      .post(PAYME_WEBHOOK_PATH)
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .send('{"method": broken');

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32700);
    // The broken text reached our handler rather than being rejected upstream.
    expect(handleRaw).toHaveBeenCalledWith(AUTH, '{"method": broken');
  });

  it('forwards the Authorization header verbatim', async () => {
    await request(app)
      .post(PAYME_WEBHOOK_PATH)
      .set('Authorization', 'Basic wrong')
      .send({ id: 1, method: 'CheckTransaction', params: {} });

    expect(handleRaw).toHaveBeenCalledWith('Basic wrong', expect.any(String));
  });

  it('leaves other routes on the normal JSON parser', async () => {
    const seen: unknown[] = [];
    app.post('/v1/other', (req, res) => {
      seen.push(req.body);
      res.status(200).json({ ok: true });
    });

    await request(app).post('/v1/other').send({ hello: 'world' });

    // Parsed object, not raw text — the middleware is scoped to Payme only.
    expect(seen[0]).toEqual({ hello: 'world' });
  });
});
