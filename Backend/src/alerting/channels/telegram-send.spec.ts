// sendTelegramHtml over the REAL installed Telegraf and its node-fetch client, against a
// Bot API stand-in on 127.0.0.1. Nothing leaves the machine and no real token is used.
// What this pins: the wire format Telegram receives, that a call Telegram never answers is
// given up on (Telegraf's own limit is 500 s), and which failures count as permanent.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Telegraf } from 'telegraf';
import { isPermanentTelegramFailure, sendTelegramHtml } from './telegram-send';

type Handler = (
  body: Record<string, unknown>,
  res: http.ServerResponse,
) => void;

let server: http.Server;
let handler: Handler;
let seen: { url: string; body: Record<string, unknown> }[];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ url: req.url ?? '', body });
      handler(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

function bot(): Telegraf {
  const { port } = server.address() as AddressInfo;
  return new Telegraf('123456:TEST-TOKEN', {
    telegram: {
      apiRoot: `http://127.0.0.1:${port}`,
      agent: new http.Agent({ keepAlive: false }),
    },
  });
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('sendTelegramHtml', () => {
  it('sends one HTML sendMessage to the chat, with link previews off', async () => {
    handler = (_body, res) =>
      reply(res, 200, { ok: true, result: { message_id: 1 } });

    await sendTelegramHtml(bot().telegram, '-1001234', '<b>Hi</b> &amp; bye');

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/bot123456:TEST-TOKEN/sendMessage');
    expect(seen[0].body).toEqual({
      chat_id: '-1001234',
      text: '<b>Hi</b> &amp; bye',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('gives up on a call Telegram never answers, instead of waiting 500 s', async () => {
    handler = () => {
      /* never answers */
    };
    const started = Date.now();

    await expect(
      sendTelegramHtml(bot().telegram, '-1001234', 'hello', 300),
    ).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects with Telegram’s error, which is permanent for a 4xx refusal', async () => {
    handler = (_body, res) =>
      reply(res, 403, {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was kicked from the group chat',
      });

    const err = await sendTelegramHtml(bot().telegram, '-1001234', 'x').catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ code: 403 });
    expect(isPermanentTelegramFailure(err)).toBe(true);
  });

  it('treats 429 and Telegram’s own 5xx as temporary', async () => {
    handler = (_body, res) =>
      reply(res, 429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 5',
        parameters: { retry_after: 5 },
      });
    const limited = await sendTelegramHtml(bot().telegram, '1', 'x').catch(
      (e: unknown) => e,
    );

    handler = (_body, res) => reply(res, 502, 'Bad Gateway');
    const down = await sendTelegramHtml(bot().telegram, '1', 'x').catch(
      (e: unknown) => e,
    );

    expect(limited).toMatchObject({ code: 429 });
    expect(isPermanentTelegramFailure(limited)).toBe(false);
    expect(down).toMatchObject({ code: 502 });
    expect(isPermanentTelegramFailure(down)).toBe(false);
  });
});

describe('isPermanentTelegramFailure', () => {
  it('is false for network errors, whose code is a string', () => {
    expect(isPermanentTelegramFailure({ code: 'ECONNRESET' })).toBe(false);
    expect(isPermanentTelegramFailure(new Error('aborted'))).toBe(false);
    expect(isPermanentTelegramFailure(null)).toBe(false);
  });

  it('is true for 400, 401 and 404 refusals', () => {
    for (const code of [400, 401, 404]) {
      expect(isPermanentTelegramFailure({ code })).toBe(true);
    }
  });
});
