/**
 * Driver's Village — fetch 1C exports from Telegram and import them. One pass;
 * a systemd timer runs it every 10 minutes (docs/DRIVERS_VILLAGE_TELEGRAM_INGEST.md).
 *
 *   npm run drivers-village:telegram-sync                 # import new exports
 *   npm run drivers-village:telegram-sync -- --dry-run    # newest export → importer --dry-run;
 *                                                         # nothing recorded, nothing written
 *   npm run drivers-village:telegram-sync -- --baseline   # mark the exports now in the chat as
 *                                                         # seen, import nothing (first setup)
 *
 * Never interactive: without an authorized session it exits 1 and points to
 * `npm run drivers-village:telegram-login`. Reads only the chat in
 * DV_TELEGRAM_CHAT_ID; imports through the existing importer CLI
 * (scripts/import-drivers-village.ts) — see src/imports/drivers-village/telegram-ingest/.
 *
 * Exit codes: 0 = pass completed (also: nothing new, another pass running,
 * an export waiting for its retry); 1 = aborted (configuration, session,
 * Telegram); 2 = an export failed for good in this pass (see the log and the
 * ledger; the file is kept in failed/).
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  acquireLock,
  LockBusyError,
} from '../src/imports/drivers-village/import-lock';
import {
  ConfigError,
  loadIngestConfig,
} from '../src/imports/drivers-village/telegram-ingest/config';
import {
  CliImportRunner,
  defaultImporterCommand,
  IMPORT_CLI_SCRIPT,
} from '../src/imports/drivers-village/telegram-ingest/import-runner';
import {
  runSync,
  type SyncMode,
} from '../src/imports/drivers-village/telegram-ingest/ingest';
import { statePaths } from '../src/imports/drivers-village/telegram-ingest/state-paths';
import {
  errorMessage,
  IngestLogger,
} from '../src/imports/drivers-village/telegram-ingest/log';
import {
  assertPrivateIfExists,
  assertPrivateStateDir,
  ensurePrivateDir,
} from '../src/imports/drivers-village/telegram-ingest/secure-fs';
import {
  closeQuietly,
  openTdlib,
  requireAuthorized,
} from '../src/imports/drivers-village/telegram-ingest/tdlib-client';
import { TdlibDocumentSource } from '../src/imports/drivers-village/telegram-ingest/tdlib-source';

function parseMode(argv: string[]): SyncMode {
  if (argv.length === 0) return 'sync';
  if (argv.length === 1 && argv[0] === '--dry-run') return 'dry-run';
  if (argv.length === 1 && argv[0] === '--baseline') return 'baseline';
  throw new ConfigError(
    'Usage: npm run drivers-village:telegram-sync [-- --dry-run | --baseline]',
  );
}

async function main(): Promise<number> {
  process.umask(0o077);
  loadDotenv({ quiet: true });
  let log = new IngestLogger();
  let mode: SyncMode;
  let config: ReturnType<typeof loadIngestConfig>;
  try {
    mode = parseMode(process.argv.slice(2));
    config = loadIngestConfig(process.env);
  } catch (error) {
    log.error(errorMessage(error));
    return 1;
  }
  log = new IngestLogger('dv-telegram', config.logLevel);
  log.addSecret(config.apiHash);

  // npm runs scripts from the package root; the importer is resolved from it.
  const projectRoot = process.cwd();
  if (!existsSync(join(projectRoot, IMPORT_CLI_SCRIPT))) {
    log.error(
      `Run this from the Backend directory (via npm run): ${IMPORT_CLI_SCRIPT} not found.`,
    );
    return 1;
  }
  const paths = statePaths(config.stateDir, config.chatId);
  try {
    assertPrivateStateDir(config.stateDir, projectRoot);
    assertPrivateIfExists(paths.tdlib);
    assertPrivateIfExists(paths.tdlibDatabase);
    assertPrivateIfExists(join(paths.tdlibDatabase, 'td.binlog'));
    assertPrivateIfExists(paths.ledger);
  } catch (error) {
    log.error(errorMessage(error));
    return 1;
  }

  let lock: ReturnType<typeof acquireLock>;
  try {
    lock = acquireLock(paths.lock, {
      label: `drivers-village:telegram-sync ${mode}`,
    });
  } catch (error) {
    if (error instanceof LockBusyError) {
      log.info('another sync or login is running; nothing to do', {
        lock: error.message,
      });
      return 0;
    }
    throw error;
  }

  const stop = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    log.warn(`received ${signal}; finishing the current step`);
    stop.abort();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    if (!existsSync(join(paths.tdlibDatabase, 'td.binlog'))) {
      log.error(
        'No Telegram session yet. An operator must run on the server: npm run drivers-village:telegram-login',
      );
      return 1;
    }
    ensurePrivateDir(paths.tdlibFiles);
    const client = openTdlib(
      config,
      { database: paths.tdlibDatabase, files: paths.tdlibFiles },
      log,
    );
    try {
      await requireAuthorized(client);
      const source = new TdlibDocumentSource(client, config.chatId);
      await source.openChat();
      log.info(`${mode} started`, {
        chatId: config.chatId,
        scanLimit: config.scanLimit,
      });
      const summary = await runSync(
        {
          config,
          source,
          runner: new CliImportRunner(defaultImporterCommand(projectRoot), log),
          log,
          signal: stop.signal,
        },
        mode,
      );
      log.info(`${mode} finished`, {
        scanned: summary.scanned,
        accepted: summary.accepted,
        imported: summary.imported,
        duplicates: summary.duplicates,
        failed: summary.failed,
        waiting: summary.waiting,
        baselined: summary.baselined,
        skipped: summary.skipped,
      });
      return summary.failed > 0 ? 2 : 0;
    } finally {
      await closeQuietly(client);
    }
  } catch (error) {
    log.error(`${mode} aborted: ${errorMessage(error)}`);
    return 1;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    lock.release();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[dv-telegram] FAILED: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
