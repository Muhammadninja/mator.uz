/**
 * CAT-001. Adds the canonical lookup form beside any catalog part number stored with
 * separators or lowercase, so a buyer finds "96 953 062" by typing 96953062. Original
 * values are kept exactly and come first; only missing canonical forms are appended.
 *
 * New projections already store both forms. This is for rows written before that.
 *
 *   Dry run (default, writes nothing):
 *     npm run backfill:part-number-search-forms
 *   Apply, with the digest the dry run printed:
 *     npm run backfill:part-number-search-forms -- --apply --confirm=<digest>
 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { withSearchForms } from '../src/common/normalize-oem.util';

const BATCH = 500;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const confirm = process.argv
    .find((a) => a.startsWith('--confirm='))
    ?.slice('--confirm='.length);
  const prisma = new PrismaClient();
  try {
    const changes: { id: string; gmNumbers: string[]; oemNumbers: string[] }[] = [];
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.catalogPart.findMany({
        select: { id: true, gmNumbers: true, oemNumbers: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        const gmNumbers = withSearchForms(row.gmNumbers);
        const oemNumbers = withSearchForms(row.oemNumbers);
        if (
          gmNumbers.length !== row.gmNumbers.length ||
          oemNumbers.length !== row.oemNumbers.length
        ) {
          changes.push({ id: row.id, gmNumbers, oemNumbers });
        }
      }
    }

    const digest = createHash('sha256')
      .update(JSON.stringify(changes))
      .digest('hex')
      .slice(0, 16);
    console.log(`${changes.length} parts need a lookup form. digest=${digest}`);
    for (const c of changes.slice(0, 20)) {
      console.log(`  ${c.id}: gm=${c.gmNumbers.join(', ')} oem=${c.oemNumbers.join(', ')}`);
    }
    if (!apply) {
      console.log('Dry run: nothing written. Re-run with --apply --confirm=<digest>.');
      return;
    }
    if (confirm !== digest) {
      throw new Error('--confirm does not match this run; review a fresh dry run first.');
    }
    for (const c of changes) {
      await prisma.catalogPart.update({
        where: { id: c.id },
        data: { gmNumbers: c.gmNumbers, oemNumbers: c.oemNumbers },
      });
    }
    console.log(`Updated ${changes.length} parts.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
