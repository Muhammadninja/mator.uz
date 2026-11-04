/**
 * Layout of DV_TELEGRAM_STATE_DIR (docs/DRIVERS_VILLAGE_TELEGRAM_INGEST.md §4).
 */
import { join } from 'path';
import { ledgerPath } from './ledger';

/** The session (TDLib database = the Telegram login) and the sync lock. */
export function sessionPaths(stateDir: string) {
  return {
    lock: join(stateDir, 'sync.lock'),
    tdlib: join(stateDir, 'tdlib'),
    tdlibDatabase: join(stateDir, 'tdlib', 'db'),
    tdlibFiles: join(stateDir, 'tdlib', 'files'),
  };
}

export function statePaths(stateDir: string, chatId: number) {
  return {
    ...sessionPaths(stateDir),
    inbox: join(stateDir, 'inbox'),
    archive: join(stateDir, 'archive'),
    failed: join(stateDir, 'failed'),
    reports: join(stateDir, 'reports'),
    dryRun: join(stateDir, 'dry-run'),
    ledger: ledgerPath(stateDir, chatId),
  };
}

export type StatePaths = ReturnType<typeof statePaths>;
