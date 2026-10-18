import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  FakeChat,
  MemoryLogger,
  NOW,
  privateTempDir,
  reportStub,
  ScriptedImporter,
  testConfig,
} from '../../../../test/utils/dv-telegram-fakes';
import type { IngestConfig } from './config';
import { Ledger } from './ledger';
import { runSync, type SyncMode } from './ingest';
import { retryDelayMs } from './process-export';
import { statePaths } from './state-paths';

const EXPORT_A = 'code_1c\tname\tunit\tprice\rA-1\tФильтр\tшт.\t900\r';
const EXPORT_B = 'code_1c\tname\tunit\tprice\rB-1\tКолодки\tшт.\t700\r';

function setup(overrides: Partial<IngestConfig> = {}) {
  const config = testConfig(privateTempDir(), overrides);
  const chat = new FakeChat();
  const importer = new ScriptedImporter();
  const log = new MemoryLogger();
  let clock = NOW.getTime();
  const sync = (mode: SyncMode = 'sync') =>
    runSync(
      {
        config,
        source: chat,
        runner: importer,
        log,
        now: () => new Date(clock),
      },
      mode,
    );
  const paths = statePaths(config.stateDir, config.chatId);
  const ledger = () => Ledger.load(paths.ledger, config.chatId);
  const advance = (ms: number) => {
    clock += ms;
  };
  return { config, chat, importer, log, sync, paths, ledger, advance };
}

describe('Telegram ingest — one pass', () => {
  it('imports a new export through the importer and ignores everything else', async () => {
    const { chat, importer, sync, paths, ledger } = setup();
    chat.post(1, 'hello', { noDocument: true });
    chat.post(2, EXPORT_B, { isOutgoing: true });
    chat.post(3, EXPORT_B, { isForwarded: true });
    chat.post(4, EXPORT_B, { senderId: 555 });
    chat.post(5, EXPORT_B, { fileName: 'notes.txt' });
    chat.post(6, EXPORT_B, { minutesAgo: 48 * 60 });
    chat.post(7, EXPORT_A, { fileName: 'dv_parts_2026_10_18.txt' });

    const summary = await sync();

    expect(summary).toMatchObject({
      scanned: 7,
      accepted: 1,
      imported: 1,
      failed: 0,
      waiting: 0,
    });
    expect(summary.skipped).toEqual({
      not_a_document: 1,
      outgoing: 1,
      forwarded: 1,
      sender_not_allowed: 1,
      file_name_not_allowed: 1,
      too_old: 1,
    });
    expect(chat.downloads).toEqual([7]);
    expect(importer.calls).toHaveLength(1);
    const call = importer.calls[0];
    expect(call).toMatchObject({
      dryRun: false,
      file: join(paths.inbox, '7-dv_parts_2026_10_18.txt'),
    });
    expect(call.reportDir.startsWith(paths.reports)).toBe(true);
    // The importer reads the bytes exactly as Telegram delivered them.
    expect(
      readFileSync(join(paths.archive, '7-dv_parts_2026_10_18.txt'), 'utf8'),
    ).toBe(EXPORT_A);
    expect(readdirSync(paths.inbox)).toEqual([]);
    expect(ledger().get(7)).toMatchObject({
      status: 'imported',
      attempts: 1,
      lastError: null,
    });
    expect(ledger().lastImported).toMatchObject({ messageId: 7 });
  });

  it('is idempotent: a second pass downloads and imports nothing', async () => {
    const { chat, importer, sync } = setup();
    chat.post(7, EXPORT_A);
    await sync();
    const again = await sync();
    expect(again).toMatchObject({ accepted: 1, imported: 0 });
    expect(chat.downloads).toEqual([7]);
    expect(importer.calls).toHaveLength(1);
  });

  it('does not re-import the same content sent again as a new message', async () => {
    const { chat, importer, sync, ledger } = setup();
    chat.post(7, EXPORT_A);
    await sync();
    chat.post(8, EXPORT_A);
    const summary = await sync();
    expect(summary).toMatchObject({ imported: 0, duplicates: 1 });
    expect(importer.calls).toHaveLength(1);
    expect(ledger().get(8)).toMatchObject({ status: 'duplicate' });
  });

  it('imports several new exports oldest first', async () => {
    const { chat, importer, sync } = setup();
    chat.post(9, EXPORT_B);
    chat.post(8, EXPORT_A);
    await sync();
    expect(importer.calls.map((c) => c.file)).toEqual([
      expect.stringContaining('/8-'),
      expect.stringContaining('/9-'),
    ]);
  });

  it('orders by the time a message was sent, then by id — not by the order of the listing', async () => {
    const { chat, importer, sync } = setup();
    chat.post(20, EXPORT_A, { minutesAgo: 10 });
    chat.post(21, EXPORT_B, { minutesAgo: 30 }); // sent earlier
    chat.post(22, 'code_1c\tname\r3\tx\r', { minutesAgo: 30 }); // same second as 21
    await sync();
    expect(importer.calls.map((c) => c.file)).toEqual([
      expect.stringContaining('/21-'),
      expect.stringContaining('/22-'),
      expect.stringContaining('/20-'),
    ]);
  });

  it('re-delivery: the same message is never imported twice; the same content after another export is', async () => {
    const { chat, importer, sync, ledger } = setup();
    chat.post(7, EXPORT_A);
    await sync();
    await sync(); // 7 is listed again
    chat.post(8, EXPORT_B);
    await sync();
    chat.post(9, EXPORT_A); // A again, but B is the newest state now
    const summary = await sync();
    expect(summary).toMatchObject({ imported: 1, duplicates: 0 });
    expect(importer.calls.map((c) => c.file)).toEqual([
      expect.stringContaining('/7-'),
      expect.stringContaining('/8-'),
      expect.stringContaining('/9-'),
    ]);
    expect(ledger().lastImported).toMatchObject({ messageId: 9 });
  });

  it('retries a transient failure later, reusing the download, and holds newer exports back meanwhile', async () => {
    const { chat, importer, sync, ledger, advance } = setup();
    chat.post(8, EXPORT_A);
    chat.post(9, EXPORT_B);
    importer.script.push({ exitCode: 1, report: null }); // e.g. the database was unreachable

    const first = await sync();
    expect(first).toMatchObject({ imported: 0, waiting: 1 });
    expect(importer.calls).toHaveLength(1);
    const entry = ledger().get(8)!;
    expect(entry).toMatchObject({ status: 'retry', attempts: 1 });
    expect(new Date(entry.nextAttemptAt!).getTime()).toBe(
      NOW.getTime() + retryDelayMs(1),
    );
    expect(ledger().get(9)).toBeUndefined();

    advance(60_000); // before the retry is due: nothing happens
    await sync();
    expect(importer.calls).toHaveLength(1);

    advance(retryDelayMs(1));
    const later = await sync();
    expect(later).toMatchObject({ imported: 2 });
    expect(chat.downloads).toEqual([8, 9]); // 8 was not downloaded twice
    expect(ledger().get(8)).toMatchObject({ status: 'imported', attempts: 2 });
  });

  it('gives up after the last attempt, keeps the file in failed/ and moves on', async () => {
    const { chat, importer, sync, ledger, advance, paths } = setup({
      maxAttempts: 2,
    });
    chat.post(8, EXPORT_A);
    importer.script.push(
      { exitCode: 1, report: null },
      { exitCode: 1, report: null },
    );
    await sync();
    advance(retryDelayMs(1));
    chat.post(9, EXPORT_B);
    const summary = await sync();
    expect(summary).toMatchObject({ failed: 1, imported: 1 });
    expect(ledger().get(8)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(readdirSync(paths.failed)).toEqual(['8-dv_parts_2026_10_18_8.txt']);
    expect(ledger().get(9)).toMatchObject({ status: 'imported' });
  });

  it('fails a file the importer rejects at once and imports the next one', async () => {
    const { chat, importer, sync, ledger, log } = setup();
    chat.post(8, 'code_1c;name;price\rA;B;1\r'); // ;-delimited: not the format the importer reads
    chat.post(9, EXPORT_B);
    importer.script.push({
      exitCode: 1,
      report: reportStub({
        meta: {
          aborted: true,
          abortReason: 'Header problems: Missing required column: code_1c',
        },
        summary: { written: null },
      }),
    });
    const summary = await sync();
    expect(summary).toMatchObject({ failed: 1, imported: 1 });
    expect(ledger().get(8)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(ledger().get(8)!.lastError).toContain('Missing required column');
    expect(log.text()).toContain('export rejected; it will not be retried');
  });

  it('a busy import lock (a manual import) postpones without counting an attempt', async () => {
    const { chat, importer, sync, ledger } = setup();
    chat.post(8, EXPORT_A);
    importer.script.push({ exitCode: 3, report: null });
    const summary = await sync();
    expect(summary).toMatchObject({ waiting: 1 });
    expect(ledger().get(8)).toMatchObject({ status: 'retry', attempts: 0 });
  });

  it('a download failure is retried', async () => {
    const { chat, importer, sync, ledger, advance } = setup();
    chat.post(8, EXPORT_A);
    chat.failDownloads = 1;
    await sync();
    expect(ledger().get(8)).toMatchObject({
      status: 'retry',
      attempts: 1,
      sha256: null,
    });
    expect(ledger().get(8)!.lastError).toContain('network is unreachable');
    expect(importer.calls).toHaveLength(0);
    advance(retryDelayMs(1));
    await sync();
    expect(ledger().get(8)).toMatchObject({ status: 'imported' });
  });

  it('a truncated download is retried, a binary file is rejected without running the importer', async () => {
    const { chat, importer, sync, ledger } = setup();
    chat.post(8, EXPORT_A, { size: EXPORT_A.length + 10 });
    await sync();
    expect(ledger().get(8)!.lastError).toContain('Telegram announced');

    const other = setup();
    other.chat.post(8, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    const summary = await other.sync();
    expect(summary.failed).toBe(1);
    expect(other.ledger().get(8)!.lastError).toContain('binary');
    expect(other.importer.calls).toHaveLength(0);
    expect(importer.calls).toHaveLength(0);
  });

  it('recovers from a crash during the download: the partial file is dropped and the export fetched again', async () => {
    const { chat, importer, sync, ledger, paths } = setup();
    const message = chat.post(8, EXPORT_A);
    await sync('baseline'); // creates the state directories
    const entry = ledger().get(8)!;
    // The state a killed pass leaves: entry "downloading", a .part in inbox/.
    ledger().put({ ...entry, status: 'downloading' }, NOW);
    writeFileSync(
      join(paths.inbox, `8-${message.document!.fileName}.part`),
      'code_1c\tna',
    );

    const summary = await sync();
    expect(summary).toMatchObject({ imported: 1 });
    expect(ledger().get(8)).toMatchObject({ status: 'imported', attempts: 1 });
    expect(readdirSync(paths.inbox)).toEqual([]);
    expect(
      readFileSync(
        importer.calls[0].file.replace(paths.inbox, paths.archive),
        'utf8',
      ),
    ).toBe(EXPORT_A);
  });

  it('resumes an import interrupted by a crash', async () => {
    const { chat, importer, sync, ledger } = setup();
    chat.post(8, EXPORT_A);
    importer.script.push(() => {
      throw new Error('simulated crash'); // the process died during the import
    });
    await expect(sync()).rejects.toThrow('simulated crash');
    expect(ledger().get(8)).toMatchObject({ status: 'importing', attempts: 1 });

    await sync();
    expect(ledger().get(8)).toMatchObject({ status: 'imported', attempts: 2 });
    expect(chat.downloads).toEqual([8]);
  });

  it('gives up on an unfinished export once it is older than the age limit', async () => {
    const { chat, importer, sync, ledger, advance, paths } = setup();
    chat.post(8, EXPORT_A);
    importer.script.push({ exitCode: 1, report: null });
    await sync();
    advance(25 * 3_600_000); // the export is now older than DV_TELEGRAM_MAX_AGE_HOURS
    const summary = await sync();
    expect(summary.failed).toBe(1);
    expect(ledger().get(8)).toMatchObject({ status: 'failed' });
    expect(readdirSync(paths.failed)).toEqual(['8-dv_parts_2026_10_18_8.txt']);
    expect(importer.calls).toHaveLength(1);
  });

  it('resumes from the local copy when the history answer misses the message', async () => {
    const { chat, importer, sync, ledger, advance } = setup();
    chat.post(8, EXPORT_A);
    importer.script.push({ exitCode: 1, report: null });
    await sync();
    const listed = chat.messages.splice(0); // a short / empty history answer
    advance(retryDelayMs(1));
    const summary = await sync();
    expect(summary).toMatchObject({ imported: 1, failed: 0 });
    expect(ledger().get(8)).toMatchObject({ status: 'imported' });
    expect(chat.downloads).toEqual([8]);
    expect(listed).toHaveLength(1);
  });

  it('never imports a newer export while an older one is unfinished and unlisted', async () => {
    const { chat, importer, sync, ledger, advance } = setup();
    chat.post(8, EXPORT_A);
    chat.failDownloads = 1; // no local copy of 8
    await sync();
    const [eight] = chat.messages.splice(0);
    chat.post(9, EXPORT_B);
    advance(retryDelayMs(1));
    const summary = await sync();
    expect(summary).toMatchObject({ imported: 0, waiting: 1, failed: 0 });
    expect(importer.calls).toHaveLength(0);
    expect(ledger().get(9)).toBeUndefined();

    chat.messages.push(eight); // listed again
    await sync();
    expect(importer.calls.map((c) => c.file)).toEqual([
      expect.stringContaining('/8-'),
      expect.stringContaining('/9-'),
    ]);
  });

  it('a stop request during a download is not counted as an attempt', async () => {
    const { chat, config, importer, ledger, paths } = setup();
    chat.post(8, EXPORT_A);
    const stop = new AbortController();
    const stoppingChat = {
      listRecentMessages: (limit: number) => chat.listRecentMessages(limit),
      download: () => {
        stop.abort();
        return Promise.reject(new Error('stopped'));
      },
    };
    await runSync(
      {
        config,
        source: stoppingChat,
        runner: importer,
        log: new MemoryLogger(),
        now: () => NOW,
        signal: stop.signal,
      },
      'sync',
    );
    expect(ledger().get(8)).toMatchObject({ status: 'retry', attempts: 0 });
    expect(readdirSync(paths.inbox)).toEqual([]);
  });

  it('dry run: checks the newest export with the importer’s --dry-run and records nothing', async () => {
    const { chat, importer, sync, paths } = setup();
    chat.post(8, EXPORT_A);
    chat.post(9, EXPORT_B);
    const summary = await sync('dry-run');
    expect(importer.calls).toHaveLength(1);
    expect(importer.calls[0]).toMatchObject({ dryRun: true });
    expect(importer.calls[0].file).toContain(`${paths.dryRun}/9-`);
    expect(summary.dryRun).toMatchObject({
      messageId: 9,
      outcome: { kind: 'imported' },
    });
    expect(existsSync(paths.ledger)).toBe(false);
    expect(readdirSync(paths.dryRun)).toEqual([]);
    expect(readdirSync(paths.inbox)).toEqual([]);
  });

  it('baseline: exports already in the chat are marked, only later ones are imported', async () => {
    const { chat, importer, sync, ledger } = setup();
    chat.post(8, EXPORT_A);
    const baseline = await sync('baseline');
    expect(baseline).toMatchObject({ baselined: 1, imported: 0 });
    expect(chat.downloads).toEqual([]);
    chat.post(9, EXPORT_B);
    await sync();
    expect(importer.calls).toHaveLength(1);
    expect(ledger().get(8)).toMatchObject({ status: 'baseline' });
    expect(ledger().get(9)).toMatchObject({ status: 'imported' });
  });

  it('never logs the api_hash or the file content', async () => {
    const { chat, sync, log, config } = setup();
    chat.post(8, EXPORT_A);
    await sync();
    expect(log.text()).not.toContain(config.apiHash);
    expect(log.text()).not.toContain('Фильтр');
  });
});
