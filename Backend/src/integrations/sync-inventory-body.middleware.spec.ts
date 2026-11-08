// ING-003: the route's own body limit, over a real HTTP request and the real parser
// ordering of main.ts (this parser first, then the app-wide default).
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { MAX_SYNC_ITEMS } from './dto/sync-inventory.dto';
import {
  MAX_SYNC_BODY_BYTES,
  SYNC_INVENTORY_PATH,
  syncInventoryBodyMiddleware,
} from './sync-inventory-body.middleware';

function app() {
  const server = express();
  server.use(SYNC_INVENTORY_PATH, syncInventoryBodyMiddleware);
  server.use(express.json());
  server.post(SYNC_INVENTORY_PATH, (req, res) =>
    res.json({ items: (req.body as { items?: unknown[] }).items?.length ?? 0 }),
  );
  server.post('/other', (_req, res) => res.json({ ok: true }));
  return server;
}

/** The longest row the DTO accepts, every character escaped as \uXXXX. */
function largestRow() {
  const escaped = (n: number) => '\\u0416'.repeat(n);
  return `{"article":"${escaped(64)}","title":"${escaped(255)}","quantity":1000000,"price":10000000000.00,"unit":"${escaped(16)}","warehouse":"${escaped(64)}"}`;
}
const send = (body: string, path = SYNC_INVENTORY_PATH) =>
  request(app()).post(path).set('Content-Type', 'application/json').send(body);

describe('sync-inventory body limit (ING-003)', () => {
  it('accepts the largest valid 5,000-row upload', async () => {
    const body = `{"mode":"full","expectedTotal":${MAX_SYNC_ITEMS},"items":[${Array(MAX_SYNC_ITEMS).fill(largestRow()).join(',')}]}`;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_SYNC_BODY_BYTES);
    const res = await send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: MAX_SYNC_ITEMS });
  });

  it('accepts a bare array', async () => {
    const res = await send('[1,2]');
    expect(res.status).toBe(200);
  });

  /**
   * Over a raw socket, because the answer legitimately arrives while the client is
   * still sending: an HTTP library may report that as a write error instead.
   */
  function oversized(headers: Record<string, string | number>, first: Buffer) {
    return new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const server = app().listen(0, () => {
        const { port } = server.address() as AddressInfo;
        const req = http.request(
          {
            port,
            method: 'POST',
            path: SYNC_INVENTORY_PATH,
            headers: { 'Content-Type': 'application/json', ...headers },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += String(chunk)));
            res.on('end', () => {
              req.destroy();
              server.close();
              server.closeAllConnections();
              resolve({ status: res.statusCode, body });
            });
          },
        );
        req.on('error', reject);
        req.write(first);
      });
    });
  }

  it('answers 413 from the declared length, before reading the body', async () => {
    const res = await oversized(
      { 'Content-Length': MAX_SYNC_BODY_BYTES + 1 },
      Buffer.from('{'),
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 413 for a chunked body that passes the limit', async () => {
    const res = await oversized(
      { 'Transfer-Encoding': 'chunked' },
      Buffer.alloc(MAX_SYNC_BODY_BYTES + 1, 'x'),
    );
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 400 for malformed JSON, not a 500', async () => {
    const res = await send('{"items":[');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('answers 400 for a JSON scalar', async () => {
    const res = await send('5');
    expect(res.status).toBe(400);
  });

  it('does not raise the limit of any other route', async () => {
    const res = await send(`{"a":"${'x'.repeat(200_000)}"}`, '/other');
    expect(res.status).toBe(413);
  });
});
