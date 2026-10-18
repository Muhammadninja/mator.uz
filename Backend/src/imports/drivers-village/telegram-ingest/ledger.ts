/**
 * The ingest's ledger: what happened to every accepted Telegram document,
 * keyed by message id, one JSON file per chat in the state directory
 * (ledger-<chatId>.json, written atomically, mode 0600).
 *
 *   downloading ─► importing ─► imported
 *        │              ├─────► retry ──(backoff)──► importing …
 *        │              └─────► failed            (rejected file, or attempts exhausted)
 *        └─(same SHA-256 as the last import)─────► duplicate
 *   baseline: seen when the ingest was set up, deliberately not imported.
 *
 * A terminal entry (imported / duplicate / failed / baseline) is never
 * processed again, which makes repeated runs idempotent. `lastImported`
 * remembers the content of the newest import, so the same export re-sent as a
 * new message is recognised and not imported twice in a row.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { writeFileAtomic } from './secure-fs';

export type EntryStatus =
  | 'downloading'
  | 'importing'
  | 'retry'
  | 'imported'
  | 'duplicate'
  | 'failed'
  | 'baseline';

const TERMINAL: readonly EntryStatus[] = [
  'imported',
  'duplicate',
  'failed',
  'baseline',
];

export function isTerminal(status: EntryStatus): boolean {
  return TERMINAL.includes(status);
}

export interface LedgerEntry {
  messageId: number;
  /** The file name as sent. */
  fileName: string;
  size: number;
  uniqueId: string;
  /** When the message was sent (ISO). */
  messageDate: string;
  status: EntryStatus;
  /** Failed processing attempts (download or import) so far. */
  attempts: number;
  sha256: string | null;
  /** Name of the local copy inside inbox/, archive/ or failed/. */
  localFile: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** Short result of the last import (counts), for operators. */
  result: string | null;
  /** Directory of the importer's JSON report / issues CSV for the last run. */
  reportDir: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface LedgerData {
  version: 1;
  chatId: number;
  lastImported: { messageId: number; sha256: string; at: string } | null;
  entries: Record<string, LedgerEntry>;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export function ledgerPath(stateDir: string, chatId: number): string {
  return join(stateDir, `ledger-${chatId}.json`);
}

export class Ledger {
  private constructor(
    readonly path: string,
    private readonly data: LedgerData,
  ) {}

  static load(path: string, chatId: number): Ledger {
    if (!existsSync(path)) {
      return new Ledger(path, {
        version: 1,
        chatId,
        lastImported: null,
        entries: {},
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new LedgerError(
        `${path} is not valid JSON. Move it aside to start a fresh ledger (already imported exports may then be imported once more).`,
      );
    }
    if (!isLedgerData(parsed) || parsed.chatId !== chatId) {
      throw new LedgerError(
        `${path} is not a ledger (version 1) for chat ${chatId}.`,
      );
    }
    return new Ledger(path, parsed);
  }

  get lastImported(): LedgerData['lastImported'] {
    return this.data.lastImported;
  }

  get(messageId: number): LedgerEntry | undefined {
    return this.data.entries[String(messageId)];
  }

  entries(): LedgerEntry[] {
    return Object.values(this.data.entries).sort(
      (a, b) => a.messageId - b.messageId,
    );
  }

  /** Store the entry and persist the ledger at once. */
  put(entry: LedgerEntry, now: Date): void {
    this.data.entries[String(entry.messageId)] = {
      ...entry,
      updatedAt: now.toISOString(),
    };
    this.save();
  }

  markImported(messageId: number, sha256: string, now: Date): void {
    this.data.lastImported = { messageId, sha256, at: now.toISOString() };
    this.save();
  }

  /** Drop terminal entries last updated before `cutoff`. */
  prune(cutoff: Date): number {
    let removed = 0;
    for (const [key, entry] of Object.entries(this.data.entries)) {
      if (isTerminal(entry.status) && new Date(entry.updatedAt) < cutoff) {
        delete this.data.entries[key];
        removed += 1;
      }
    }
    if (removed) this.save();
    return removed;
  }

  private save(): void {
    writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

function isLedgerData(value: unknown): value is LedgerData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<LedgerData>;
  return (
    v.version === 1 &&
    typeof v.chatId === 'number' &&
    typeof v.entries === 'object' &&
    v.entries !== null &&
    (v.lastImported === null || typeof v.lastImported === 'object')
  );
}
