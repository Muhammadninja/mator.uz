/**
 * The DocumentSource of the ingest on top of TDLib: reads the history of the
 * ONE configured chat (never any other chat) and downloads a document.
 *
 *   getChatHistory   — newest first, paged, from the server (TDLib's message
 *                      database is off, so nothing is cached between runs)
 *   downloadFile     — synchronous: the promise resolves when the file is
 *                      complete; it is then copied into inbox/ and TDLib's own
 *                      copy is deleted
 */
import { chmodSync, constants as fsConstants, copyFileSync } from 'fs';
import type * as tdl from 'tdl';
import type * as Td from 'tdlib-types';
import type { IncomingDocument, IncomingMessage } from './document-filter';
import type { DocumentSource } from './ingest';
import { isTdError, withTimeout } from './tdlib-client';

const PAGE = 100;

export class TdlibDocumentSource implements DocumentSource {
  constructor(
    private readonly client: tdl.Client,
    private readonly chatId: number,
    private readonly downloadTimeoutMs = 10 * 60_000,
  ) {}

  /**
   * Make TDLib know the chat. Its chat-info database keeps it after the first
   * run, so later runs need no extra requests.
   */
  async openChat(): Promise<void> {
    if (await this.chatKnown()) return;
    if (this.chatId > 0) {
      try {
        await this.client.invoke({
          _: 'createPrivateChat',
          user_id: this.chatId,
          force: false,
        });
        return;
      } catch {
        // Unknown user so far: load the chat list below.
      }
    }
    for (let page = 0; page < 10; page += 1) {
      try {
        await this.client.invoke({
          _: 'loadChats',
          chat_list: { _: 'chatListMain' },
          limit: PAGE,
        });
      } catch (error) {
        if (isTdError(error, 404)) break; // every chat is loaded
        throw error;
      }
      if (await this.chatKnown()) return;
    }
    throw new Error(
      `Chat ${this.chatId} is not visible to this Telegram account. Check DV_TELEGRAM_CHAT_ID (npm run drivers-village:telegram-login -- --list-chats).`,
    );
  }

  async listRecentMessages(limit: number): Promise<IncomingMessage[]> {
    const seen = new Map<number, IncomingMessage>();
    let fromMessageId = 0;
    for (let page = 0; page < 50 && seen.size < limit; page += 1) {
      const result = await this.client.invoke({
        _: 'getChatHistory',
        chat_id: this.chatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: Math.min(PAGE, limit - seen.size),
        only_local: false,
      });
      const messages = result.messages.filter(
        (m): m is Td.message => m !== null,
      );
      if (!messages.length) break;
      for (const m of messages) seen.set(m.id, mapTdMessage(m));
      fromMessageId = messages[messages.length - 1].id;
    }
    return [...seen.values()].sort((a, b) => b.id - a.id).slice(0, limit);
  }

  async download(
    document: IncomingDocument,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const cancel = () => {
      this.client
        .invoke({
          _: 'cancelDownloadFile',
          file_id: document.fileId,
          only_if_pending: false,
        })
        .catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const file = await withTimeout(
        this.client.invoke({
          _: 'downloadFile',
          file_id: document.fileId,
          priority: 16,
          offset: 0,
          limit: 0,
          synchronous: true,
        }),
        this.downloadTimeoutMs,
        'the download timed out',
        cancel,
      );
      if (signal?.aborted) throw new Error('stopped');
      if (!file.local.is_downloading_completed || !file.local.path)
        throw new Error('TDLib did not complete the download');
      copyFileSync(file.local.path, destination, fsConstants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
    } finally {
      signal?.removeEventListener('abort', cancel);
      await this.client
        .invoke({ _: 'deleteFile', file_id: document.fileId })
        .catch(() => undefined);
    }
  }

  private async chatKnown(): Promise<boolean> {
    try {
      await this.client.invoke({ _: 'getChat', chat_id: this.chatId });
      return true;
    } catch {
      return false;
    }
  }
}

/** TDLib message → the fields the filter and the ingest use. */
export function mapTdMessage(m: Td.message): IncomingMessage {
  const content = m.content;
  const document =
    content._ === 'messageDocument'
      ? {
          fileId: content.document.document.id,
          uniqueId: content.document.document.remote.unique_id,
          fileName: content.document.file_name,
          mimeType: content.document.mime_type,
          size: content.document.document.size,
        }
      : null;
  return {
    id: m.id,
    chatId: m.chat_id,
    date: m.date,
    isOutgoing: m.is_outgoing,
    senderId:
      m.sender_id._ === 'messageSenderUser'
        ? m.sender_id.user_id
        : m.sender_id.chat_id,
    isForwarded: Boolean(m.forward_info || m.import_info),
    document,
  };
}
