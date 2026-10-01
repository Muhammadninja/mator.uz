/**
 * DRY-RUN validator for the explicit business TOP-300 list
 * (src/admin/fitment-studio/top300/fitment-top300.list.ts).
 *
 * It NEVER connects to a database and NEVER writes anything: there is no
 * Prisma client in this file. It checks the list on its own (order,
 * duplicates, malformed ids, size against 300) and — when given a file of
 * known CatalogPart ids — reports each entry as resolved / unknown.
 *
 *   npm run fitment:top300 -- --dry-run
 *   npm run fitment:top300 -- --dry-run --known ./part-ids.txt
 *
 * `--known` takes a newline-separated list or a JSON array of CatalogPart ids
 * (for example exported from the admin catalogue). Without it every valid
 * entry is reported as `unchecked`; the live queue reports missing ids itself
 * (`meta.top300.missing` on GET /v1/admin/fitment/parts-queue?filter=top300).
 *
 * Exit code 1 when the list has duplicates, invalid or unknown ids — usable as
 * a pre-deploy gate.
 */
import { readFileSync } from 'fs';
import { FITMENT_TOP300_PART_IDS } from '../src/admin/fitment-studio/top300/fitment-top300.list';
import { validateTop300List } from '../src/admin/fitment-studio/top300/top300-list';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readKnownIds(path: string): Set<string> {
  const text = readFileSync(path, 'utf8').trim();
  const values: unknown[] = text.startsWith('[')
    ? (JSON.parse(text) as unknown[])
    : text.split(/\r?\n/);
  return new Set(
    values.map((v) => String(v).trim()).filter((v) => v.length > 0),
  );
}

function main(): number {
  if (!process.argv.includes('--dry-run')) {
    console.error(
      'Usage: npm run fitment:top300 -- --dry-run [--known <file>]\n' +
        'This tool only validates the list; it never touches a database.',
    );
    return 2;
  }

  const knownPath = argValue('--known');
  const known = knownPath ? readKnownIds(knownPath) : undefined;
  const report = validateTop300List(FITMENT_TOP300_PART_IDS, known);

  console.log('position\tidentifier\tstatus');
  for (const e of report.entries) {
    const note = e.firstPosition ? ` (first at #${e.firstPosition})` : '';
    console.log(`${e.position}\t${e.identifier}\t${e.status}${note}`);
  }

  console.log(
    `\n[fitment:top300] dry-run — nothing written, no database contacted.\n` +
      `  entries:    ${report.entries.length}\n` +
      `  usable ids: ${report.ids.length} / target ${report.targetSize}` +
      `${report.isComplete ? '' : ' (incomplete — never padded with other parts)'}\n` +
      `  duplicates: ${report.duplicates.length}\n` +
      `  invalid:    ${report.invalid.length}\n` +
      `  unknown:    ${known ? report.unknown.length : 'not checked (no --known file)'}`,
  );

  const problems =
    report.duplicates.length + report.invalid.length + report.unknown.length;
  return problems > 0 ? 1 : 0;
}

process.exitCode = main();
