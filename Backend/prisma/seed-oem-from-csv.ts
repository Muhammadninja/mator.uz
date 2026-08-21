/**
 * Bulk OEM-catalogue import from a supplier CSV price-list.
 *
 * The scalable path to a full catalogue: drop a real price-list at
 * `prisma/data/oem-catalog.csv` (or pass a path) and every row is upserted into
 * `catalog_parts` with make/model fit rows — appearing immediately on the
 * storefront AND under the garage "Shop parts that fit" (`?make&model`) filter.
 *
 * CSV columns (header row required; order-independent; extra columns ignored):
 *   title        — part name (required)
 *   brand        — manufacturer display name (required), e.g. Hi-Q, NGK
 *   make         — vehicle make (optional, default "Chevrolet")
 *   models       — fitment models, '|'-separated, e.g. "Cobalt|Gentra|Spark" (required)
 *   categorySlug — one of the 52 subcategory slugs, e.g. front-brake-pads (required)
 *   mainCategory — PartMainCategory fallback (optional; the category's own bucket wins)
 *   oemNumbers   — OEM + cross codes, '|'-separated, e.g. "95939923|SP1362" (required)
 *   priceUzs     — whole UZS (required)
 *   stockQty     — optional, default 10
 *   isOem        — "true"/"1" for a genuine OEM part (optional, default false)
 *   id           — optional stable id; when omitted a deterministic one is derived
 *
 * Idempotent: re-running the same CSV updates rows (upsert on id), never duplicates.
 *
 * Run:  npm run seed:oem:csv               # reads prisma/data/oem-catalog.csv
 *       npm run seed:oem:csv -- /abs/path.csv
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient, PartMainCategory } from '@prisma/client';
import { ensureOemSeller, upsertOemPart, slugify, type OemSeedRecord } from './oem-seed.helpers';
import { normalizeOem } from '../src/common/normalize-oem.util';

const prisma = new PrismaClient();

/** Minimal RFC-4180 CSV parser: quoted fields, commas/newlines in quotes, "" escapes. */
function parseCsv(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // Drop fully-empty lines.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const splitList = (v: string) => (v ?? '').split('|').map((s) => s.trim()).filter(Boolean);
const toInt = (v: string) => Number.parseInt((v ?? '').replace(/[^\d]/g, ''), 10);
const isMainCategory = (v: string): v is PartMainCategory =>
  (Object.values(PartMainCategory) as string[]).includes(v);

async function main() {
  const file = resolve(process.argv[2] ?? resolve(__dirname, 'data/oem-catalog.csv'));
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (rows.length < 2) {
    // eslint-disable-next-line no-console
    console.error(`seed:oem:csv — no data rows in ${file}`);
    process.exitCode = 1;
    return;
  }

  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    id: col('id'), title: col('title'), brand: col('brand'), make: col('make'),
    models: col('models'), categorySlug: col('categorySlug'), mainCategory: col('mainCategory'),
    oemNumbers: col('oemNumbers'), priceUzs: col('priceUzs'), stockQty: col('stockQty'), isOem: col('isOem'),
  };
  for (const required of ['title', 'brand', 'models', 'categorySlug', 'oemNumbers', 'priceUzs'] as const) {
    if (idx[required] < 0) {
      // eslint-disable-next-line no-console
      console.error(`seed:oem:csv — CSV is missing required column "${required}". Header: ${header.join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  await ensureOemSeller(prisma);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let invalid = 0;

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : '');

    const title = get(idx.title);
    const brand = get(idx.brand);
    const categorySlug = get(idx.categorySlug);
    const models = splitList(get(idx.models));
    const oemNumbers = splitList(get(idx.oemNumbers));
    const priceUzs = toInt(get(idx.priceUzs));
    const make = get(idx.make) || 'Chevrolet';

    if (!title || !categorySlug || models.length === 0 || oemNumbers.length === 0 || !Number.isFinite(priceUzs) || priceUzs <= 0) {
      // eslint-disable-next-line no-console
      console.warn(`✗ row ${r + 1}: incomplete (title/models/categorySlug/oemNumbers/priceUzs) — skipped`);
      invalid += 1;
      continue;
    }

    const mainCatRaw = get(idx.mainCategory);
    const firstModel = models[0];
    const firstCode = normalizeOem(oemNumbers[0]);
    const id = get(idx.id) ||
      `csv_${slugify(make)}_${slugify(firstModel)}_${categorySlug}_${firstCode || slugify(title).slice(0, 24)}`;

    const record: OemSeedRecord = {
      id,
      title,
      brand,
      make,
      models,
      categorySlug,
      mainCategory: isMainCategory(mainCatRaw) ? mainCatRaw : null,
      oemNumbers,
      priceUzs,
      stockQty: Number.isFinite(toInt(get(idx.stockQty))) && toInt(get(idx.stockQty)) > 0 ? toInt(get(idx.stockQty)) : 10,
      isOem: ['true', '1', 'yes'].includes(get(idx.isOem).toLowerCase()),
    };

    const result = await upsertOemPart(prisma, record);
    if (result === 'created') created += 1;
    else if (result === 'updated') updated += 1;
    else {
      // eslint-disable-next-line no-console
      console.warn(`✗ row ${r + 1} "${id}": category slug "${categorySlug}" not found (run seed:categories first)`);
      skipped += 1;
    }
  }

  const total = await prisma.catalogPart.count();
  // eslint-disable-next-line no-console
  console.log(
    `✓ seed:oem:csv done — created ${created}, updated ${updated}, skipped(no-category) ${skipped}, invalid ${invalid}. catalog_parts total now ${total}.`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('seed:oem:csv failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
