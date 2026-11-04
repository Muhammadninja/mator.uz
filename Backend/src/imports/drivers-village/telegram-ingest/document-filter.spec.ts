import {
  BOT_CHAT_ID,
  FakeChat,
  NOW,
  privateTempDir,
  testConfig,
  type MessageSpec,
} from '../../../../test/utils/dv-telegram-fakes';
import { evaluateMessage, type RejectReason } from './document-filter';

const rules = testConfig(privateTempDir());

function verdict(spec: MessageSpec, overrides = {}) {
  const message = new FakeChat().post(1, 'code_1c\tname\n', spec);
  return evaluateMessage(message, { ...rules, ...overrides }, NOW.getTime());
}

describe('Telegram ingest — which messages may become an import', () => {
  it('accepts a fresh tab-delimited export from the 1C bot in the allowed chat', () => {
    expect(verdict({})).toEqual({ accept: true });
    expect(
      verdict({
        mimeType: 'text/tab-separated-values',
        fileName: 'dv_parts_2026_10_18.TXT',
      }),
    ).toEqual({
      accept: true,
    });
  });

  it.each<[string, MessageSpec, RejectReason]>([
    ['another chat', { chatId: 42 }, 'other_chat'],
    ['a message this account sent', { isOutgoing: true }, 'outgoing'],
    ['a forwarded export', { isForwarded: true }, 'forwarded'],
    ['a document from someone else', { senderId: 555 }, 'sender_not_allowed'],
    ['a post without a sender', { senderId: null }, 'sender_not_allowed'],
    ['a text or photo message', { noDocument: true }, 'not_a_document'],
    [
      'an unexpected file name',
      { fileName: 'invoice.txt' },
      'file_name_not_allowed',
    ],
    [
      'a path in the name',
      { fileName: '../dv_parts_1.txt' },
      'file_name_not_allowed',
    ],
    [
      'an Excel workbook',
      { fileName: 'dv_parts_2026.xlsx' },
      'file_name_not_allowed',
    ],
    [
      'another MIME type',
      { mimeType: 'application/zip' },
      'mime_type_not_allowed',
    ],
    ['an unknown size', { size: 0 }, 'size_unknown'],
    ['a file over the limit', { size: 20 * 1024 * 1024 + 1 }, 'too_large'],
    ['old history', { minutesAgo: 25 * 60 }, 'too_old'],
  ])('skips %s', (_what, spec, reason) => {
    expect(verdict(spec)).toEqual({ accept: false, reason });
  });

  it('even a matching pattern cannot admit a format the importer does not read', () => {
    expect(
      verdict(
        { fileName: 'dv_parts_1.xlsx' },
        { fileNamePattern: /^dv_parts_/i },
      ),
    ).toEqual({
      accept: false,
      reason: 'extension_not_allowed',
    });
  });

  it('limits are inclusive, the MIME type is case-insensitive, and a ";" export may be .csv', () => {
    expect(verdict({ minutesAgo: 24 * 60 })).toEqual({ accept: true });
    expect(verdict({ minutesAgo: 24 * 60 + 1 })).toMatchObject({
      reason: 'too_old',
    });
    expect(verdict({ size: 20 * 1024 * 1024 })).toEqual({ accept: true });
    expect(verdict({ mimeType: 'Text/Plain' })).toEqual({ accept: true });
    expect(
      verdict(
        { fileName: 'dv_parts_2026_10_18.csv', mimeType: 'text/csv' },
        {
          fileNamePattern: /^dv_parts_.*\.(txt|csv)$/i,
          allowedMimeTypes: ['text/plain', 'text/csv'],
        },
      ),
    ).toEqual({ accept: true });
  });

  it('in a group only the listed senders count', () => {
    const group = { chatId: -1001234567890, senderIds: [BOT_CHAT_ID] };
    expect(verdict({ chatId: group.chatId }, group)).toEqual({ accept: true });
    expect(verdict({ chatId: group.chatId, senderId: 99 }, group)).toEqual({
      accept: false,
      reason: 'sender_not_allowed',
    });
  });
});
