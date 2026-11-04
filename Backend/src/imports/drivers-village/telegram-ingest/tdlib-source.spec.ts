/**
 * The TDLib adapter over a scripted client — no TDLib binary, no network.
 */
import { readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type * as tdl from 'tdl';
import type * as Td from 'tdlib-types';
import {
  BOT_CHAT_ID,
  privateTempDir,
} from '../../../../test/utils/dv-telegram-fakes';
import { mapTdMessage, TdlibDocumentSource } from './tdlib-source';

function tdMessage(
  id: number,
  patch: Record<string, unknown> = {},
): Td.message {
  return {
    _: 'message',
    id,
    chat_id: BOT_CHAT_ID,
    sender_id: { _: 'messageSenderUser', user_id: BOT_CHAT_ID },
    is_outgoing: false,
    date: 1_792_310_400,
    content: {
      _: 'messageDocument',
      caption: { _: 'formattedText', text: '', entities: [] },
      document: {
        _: 'document',
        file_name: 'dv_parts_2026_10_18.txt',
        mime_type: 'text/plain',
        document: {
          _: 'file',
          id: id * 10,
          size: 130_000,
          expected_size: 130_000,
          local: { _: 'localFile', path: '', is_downloading_completed: false },
          remote: { _: 'remoteFile', id: 'r', unique_id: `u${id}` },
        },
      },
    },
    ...patch,
  } as unknown as Td.message;
}

/** A client whose invoke() answers from a handler per request type. */
function scriptedClient(
  handlers: Record<string, (req: Record<string, unknown>) => unknown>,
) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    invoke: (req: Record<string, unknown>) => {
      calls.push(req);
      const handler = handlers[req._ as string];
      if (!handler)
        return Promise.reject(new Error(`unexpected ${String(req._)}`));
      try {
        return Promise.resolve(handler(req));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
  };
  return { client: client as unknown as tdl.Client, calls };
}

describe('TDLib adapter — messages', () => {
  it('maps a document from the bot', () => {
    expect(mapTdMessage(tdMessage(30 << 20))).toEqual({
      id: 30 << 20,
      chatId: BOT_CHAT_ID,
      date: 1_792_310_400,
      isOutgoing: false,
      senderId: BOT_CHAT_ID,
      isForwarded: false,
      document: {
        fileId: (30 << 20) * 10,
        uniqueId: `u${30 << 20}`,
        fileName: 'dv_parts_2026_10_18.txt',
        mimeType: 'text/plain',
        size: 130_000,
      },
    });
  });

  it('maps everything the filter needs to reject other messages', () => {
    expect(
      mapTdMessage(tdMessage(1, { content: { _: 'messagePhoto' } })).document,
    ).toBeNull();
    expect(mapTdMessage(tdMessage(1, { is_outgoing: true })).isOutgoing).toBe(
      true,
    );
    expect(
      mapTdMessage(tdMessage(1, { forward_info: { _: 'messageForwardInfo' } }))
        .isForwarded,
    ).toBe(true);
    expect(
      mapTdMessage(tdMessage(1, { import_info: { _: 'messageImportInfo' } }))
        .isForwarded,
    ).toBe(true);
    expect(
      mapTdMessage(
        tdMessage(1, {
          sender_id: { _: 'messageSenderChat', chat_id: -100123 },
        }),
      ).senderId,
    ).toBe(-100123);
  });

  it('pages through the history newest first, up to the limit', async () => {
    const pages: Record<number, Td.message[]> = {
      0: [tdMessage(30), tdMessage(29)],
      29: [tdMessage(28), tdMessage(27)],
      27: [],
    };
    const { client, calls } = scriptedClient({
      getChatHistory: (req) => ({
        _: 'messages',
        total_count: 0,
        messages: pages[req.from_message_id as number],
      }),
    });
    const source = new TdlibDocumentSource(client, BOT_CHAT_ID);
    const messages = await source.listRecentMessages(3);
    expect(messages.map((m) => m.id)).toEqual([30, 29, 28]);
    expect(calls.every((c) => c.chat_id === BOT_CHAT_ID)).toBe(true);
    expect(calls[0]).toMatchObject({
      from_message_id: 0,
      only_local: false,
      limit: 3,
    });
  });
});

describe('TDLib adapter — downloads and the chat', () => {
  it('downloads synchronously, copies the file privately and deletes TDLib’s copy', async () => {
    const dir = privateTempDir();
    const tdlibCopy = join(dir, 'tdlib-copy.txt');
    writeFileSync(tdlibCopy, 'code_1c\tname\r');
    const { client, calls } = scriptedClient({
      downloadFile: () => ({
        _: 'file',
        id: 300,
        size: 13,
        local: {
          path: tdlibCopy,
          is_downloading_completed: true,
          downloaded_size: 13,
        },
      }),
      deleteFile: () => ({ _: 'ok' }),
    });
    const source = new TdlibDocumentSource(client, BOT_CHAT_ID);
    const target = join(dir, 'inbox-file.txt.part');
    await source.download(
      {
        fileId: 300,
        uniqueId: 'u',
        fileName: 'dv_parts_1.txt',
        mimeType: 'text/plain',
        size: 13,
      },
      target,
    );
    expect(readFileSync(target, 'utf8')).toBe('code_1c\tname\r');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(calls.map((c) => c._)).toEqual(['downloadFile', 'deleteFile']);
    expect(calls[0]).toMatchObject({ file_id: 300, synchronous: true });
  });

  it('fails an incomplete download and still cleans up', async () => {
    const { client, calls } = scriptedClient({
      downloadFile: () => ({
        _: 'file',
        local: { path: '', is_downloading_completed: false },
      }),
      deleteFile: () => ({ _: 'ok' }),
    });
    const source = new TdlibDocumentSource(client, BOT_CHAT_ID);
    await expect(
      source.download(
        {
          fileId: 1,
          uniqueId: 'u',
          fileName: 'x.txt',
          mimeType: 'text/plain',
          size: 1,
        },
        join(privateTempDir(), 'x.part'),
      ),
    ).rejects.toThrow('did not complete');
    expect(calls.map((c) => c._)).toEqual(['downloadFile', 'deleteFile']);
  });

  it('opens a private chat with the bot when TDLib does not know it yet', async () => {
    let known = false;
    const { client, calls } = scriptedClient({
      getChat: () => {
        if (!known) throw new Error('Chat not found');
        return { _: 'chat' };
      },
      createPrivateChat: () => {
        known = true;
        return { _: 'chat' };
      },
    });
    await new TdlibDocumentSource(client, BOT_CHAT_ID).openChat();
    expect(calls.map((c) => c._)).toEqual(['getChat', 'createPrivateChat']);
  });

  it('names the setting to fix when the chat is not visible to the account', async () => {
    const { client } = scriptedClient({
      getChat: () => {
        throw new Error('Chat not found');
      },
      loadChats: () => {
        throw new Error('stop');
      },
    });
    await expect(
      new TdlibDocumentSource(client, -1001234567890).openChat(),
    ).rejects.toThrow('stop');
    const empty = scriptedClient({
      getChat: () => {
        throw new Error('Chat not found');
      },
      loadChats: () => ({ _: 'ok' }),
    });
    await expect(
      new TdlibDocumentSource(empty.client, -1001234567890).openChat(),
    ).rejects.toThrow('DV_TELEGRAM_CHAT_ID');
  });
});
