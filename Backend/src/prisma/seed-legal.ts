import { PrismaClient } from '@prisma/client';

import {
  formatLegalPublishReport,
  publishLegalDocuments,
} from './seed-data/legal-documents.publish';

/**
 * `npm run seed:legal` — publish docs/legal/*.md and nothing else.
 *
 * Safe for production where `npm run seed` is not: it reads and writes only
 * `legal_documents`, never dealers, categories or any other reference data.
 *
 * DRY RUN BY DEFAULT: it prints what it would create, refresh or re-date and
 * writes nothing. Add `--apply` to write, in one transaction:
 *
 *   npm run seed:legal              # plan only
 *   npm run seed:legal -- --apply   # write the plan
 */
const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  const report = await publishLegalDocuments(prisma, { dryRun: !apply });
  for (const line of formatLegalPublishReport(report)) console.log(line);
  if (!apply) console.log('[legal] Re-run with `-- --apply` to write this plan.');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
