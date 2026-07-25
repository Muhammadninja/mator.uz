/**
 * Generates the Grafana dashboard JSON files into grafana/dashboards/.
 *
 * Run: npm run grafana:build
 *
 * The generated files are committed and are what operators import — this script
 * exists so the five dashboards stay consistent with each other and so PromQL
 * lives in reviewable TypeScript rather than in 3 000 lines of nested JSON.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBackendOverview } from './backend-overview';
import { buildBullmq } from './bullmq';
import { buildImageProcessing } from './image-processing';
import { buildSms } from './sms';
import { buildBusiness } from './business';

const OUT_DIR = join(__dirname, '..', '..', 'grafana', 'dashboards');

const dashboards: [string, unknown][] = [
  ['backend-overview.json', buildBackendOverview()],
  ['bullmq.json', buildBullmq()],
  ['image-processing.json', buildImageProcessing()],
  ['sms.json', buildSms()],
  ['business.json', buildBusiness()],
];

for (const [file, doc] of dashboards) {
  const path = join(OUT_DIR, file);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const panels = (doc as { panels: unknown[] }).panels.filter(
    (p) => (p as { type: string }).type !== 'row',
  ).length;
  console.log(`✓ ${file} (${panels} panels)`);
}
