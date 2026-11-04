/**
 * Which Telegram messages may become an import. Everything else — text,
 * photos, other files, our own messages, forwards, other senders, stale
 * history — is skipped without being downloaded.
 *
 * The rules, in order (the first failing one is the reason):
 *   1. the configured chat only;
 *   2. incoming only (never a message this account sent);
 *   3. original only (no forwarded or imported message);
 *   4. from an allowed sender — DV_TELEGRAM_SENDER_IDS, or for a private chat
 *      (positive id) the chat's peer itself, i.e. the 1C bot;
 *   5. a document (a file attachment, not a photo, sticker, voice…);
 *   6. its name matches DV_TELEGRAM_FILE_PATTERN, and its extension is one the
 *      importer reads (tab- or ";"-delimited text: .txt / .tsv / .csv);
 *   7. a declared MIME type in DV_TELEGRAM_ALLOWED_MIME_TYPES;
 *   8. a known size, at most DV_TELEGRAM_MAX_FILE_BYTES (≤ the importer's
 *      own limit);
 *   9. sent within DV_TELEGRAM_MAX_AGE_HOURS.
 *
 * The content is checked after the download (size, no NUL bytes) and then by
 * the importer itself (encoding, header, rows).
 */
import { extname } from 'path';
import type { FilterRules } from './config';

export interface IncomingDocument {
  /** TDLib file id — valid for the current session only. */
  fileId: number;
  /** Stable remote id of the file. */
  uniqueId: string;
  fileName: string;
  mimeType: string;
  /** Bytes; 0 when Telegram does not know it. */
  size: number;
}

export interface IncomingMessage {
  id: number;
  chatId: number;
  /** Unix seconds. */
  date: number;
  isOutgoing: boolean;
  /** The sending user, or the chat for posts sent on behalf of a chat. */
  senderId: number | null;
  /** Forwarded or imported from elsewhere. */
  isForwarded: boolean;
  document: IncomingDocument | null;
}

export type RejectReason =
  | 'other_chat'
  | 'outgoing'
  | 'forwarded'
  | 'sender_not_allowed'
  | 'not_a_document'
  | 'file_name_not_allowed'
  | 'extension_not_allowed'
  | 'mime_type_not_allowed'
  | 'size_unknown'
  | 'too_large'
  | 'too_old';

export type Verdict =
  { accept: true } | { accept: false; reason: RejectReason };

/** Extensions of what the importer reads (tab- or ";"-delimited text). */
export const IMPORTABLE_EXTENSIONS = ['.txt', '.tsv', '.csv'];

export function evaluateMessage(
  message: IncomingMessage,
  rules: FilterRules,
  nowMs: number,
): Verdict {
  const reject = (reason: RejectReason): Verdict => ({ accept: false, reason });

  if (message.chatId !== rules.chatId) return reject('other_chat');
  if (message.isOutgoing) return reject('outgoing');
  if (message.isForwarded) return reject('forwarded');
  const senders = rules.senderIds.length ? rules.senderIds : [rules.chatId];
  if (message.senderId === null || !senders.includes(message.senderId))
    return reject('sender_not_allowed');

  const doc = message.document;
  if (!doc) return reject('not_a_document');
  if (!rules.fileNamePattern.test(doc.fileName))
    return reject('file_name_not_allowed');
  if (!IMPORTABLE_EXTENSIONS.includes(extname(doc.fileName).toLowerCase()))
    return reject('extension_not_allowed');
  if (!rules.allowedMimeTypes.includes(doc.mimeType.trim().toLowerCase()))
    return reject('mime_type_not_allowed');
  if (!Number.isSafeInteger(doc.size) || doc.size <= 0)
    return reject('size_unknown');
  if (doc.size > rules.maxFileBytes) return reject('too_large');
  if (nowMs - message.date * 1000 > rules.maxAgeHours * 3_600_000)
    return reject('too_old');
  return { accept: true };
}
