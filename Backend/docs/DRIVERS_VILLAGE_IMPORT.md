# Driver's Village 1C catalog import

Operator runbook for importing Driver's Village stock from its 1C export into
Mator. The importer is a CLI; there is no HTTP endpoint for it.

```
1C export (Excel → "Tab-delimited Text")
      │  npm run import:drivers-village
      ▼
Product · Stock · part_models / part_makes · category ids      (supply side)
      │  CatalogProjectionService.projectStock  (the one existing mapping)
      ▼
CatalogPart · catalog_part_fits · catalog_part_make_fits       (buyer catalog)
      ▼
Mator mobile app
```

Code: `src/imports/drivers-village/`, CLI: `scripts/import-drivers-village.ts`,
migration: `prisma/migrations/20260923000000_drivers_village_1c_import`.

## 1. Prerequisites (per database)

| Requirement | Why | Dry-run reports it as |
|---|---|---|
| Migration `20260923000000_drivers_village_1c_import` applied | adds seller type, source identity on stocks, number lists, make-wide fitment tables | `schema_not_migrated` |
| Catalog seller `drivers-village` exists | every position is listed under this dealer | `catalog_seller_missing` |
| A **BUSINESS** seller linked to it | `stocks.seller_id` points at a supply-side `sellers` row; the importer never creates one | `linked_seller_missing` / `linked_seller_not_business` |
| Every `category_id` / `subcategory_id` of the file exists | FK on `products.category_id` and `catalog_parts.category_id` | `blocked` rows + `environment.missingCategoryIds` |

A real import refuses to start while any of the first three is unmet and
writes nothing.

### Deploy order

1. Apply both migrations with `npx prisma migrate deploy`:
   `20260923000000_drivers_village_1c_import`, then
   `20260923010000_drivers_village_photo_updates`.
2. Deploy the backend built from this code.
3. Only then run the one-time setup below, which creates the BUSINESS seller.

The new Prisma client reads the new columns on every `sellers`,
`product_drafts` and projection query. Starting it against an unmigrated
database breaks the bot and the catalog for every seller, not only Driver's
Village. The migrations are additive, so the currently running code keeps
working after step 1. It stops working once a seller with `tg_id` NULL exists,
because the old client expects `tg_id` on every row. That is why step 3 comes
last.

### Supply-side seller model

`sellers.seller_type` is `TELEGRAM` or `BUSINESS`:

- **TELEGRAM** — every existing seller and every bot onboarding (the column
  default, also set explicitly by the bot). `tg_id` and `phone` are required;
  the database enforces it with the CHECK constraint
  `sellers_telegram_identity_check`. Nothing about these sellers changes.
- **BUSINESS** — an organization fed by an integration. `tg_id` is NULL (never
  a made-up id), `phone` is optional. The bot looks sellers up by `tg_id`, so a
  business seller can never be reached or impersonated through Telegram.

The type is internal to the supply side and is not exposed by the buyer API.

```
catalog_sellers.id = 'drivers-village'   (existing curated dealer)
        ↕  sellers.catalog_seller_id
sellers  seller_type = BUSINESS, tg_id = NULL
        ↓  stocks.seller_id
stocks   source_system = DRIVERS_VILLAGE_1C, source_code = code_1c
```

### One-time production setup (after the migration, before the first import)

Run in a transaction and review each result before committing:

```sql
BEGIN;

-- 1. Preconditions.
SELECT id, name FROM catalog_sellers WHERE id = 'drivers-village';             -- expect 1 row
SELECT id, seller_type, tg_id FROM sellers
 WHERE catalog_seller_id = 'drivers-village';                                   -- expect 0 rows

-- 2. Create and link the Driver's Village BUSINESS seller.
--    Guarded: inserts only if the dealer exists and nothing is linked yet.
INSERT INTO sellers (seller_type, tg_id, phone, store_name, status, catalog_seller_id)
SELECT 'BUSINESS', NULL, NULL, 'Drivers Village', 'ACTIVE', 'drivers-village'
WHERE EXISTS (SELECT 1 FROM catalog_sellers WHERE id = 'drivers-village')
  AND NOT EXISTS (SELECT 1 FROM sellers WHERE catalog_seller_id = 'drivers-village')
RETURNING id, seller_type, tg_id, status, catalog_seller_id;                    -- expect exactly 1 row

COMMIT;   -- ROLLBACK instead if step 2 returned no row
```

`phone` may be set to the dealer's real business number instead of NULL.
`catalog_seller_id` is unique: a second seller cannot be linked to the same
dealer. Once linked, all of this seller's stock projects into
`drivers-village` rather than a separate `seller_<id>` storefront.

## 2. Source file

Export from 1C to Excel, then **File → Save As → "Tab-delimited Text (.txt)"**.
`.xlsx` is not read directly. The encoding is detected: UTF-8, Mac Cyrillic
(Excel for Mac) or Windows-1251 (Excel for Windows). Force it with
`--encoding=utf-8|x-mac-cyrillic|windows-1251` if detection is wrong.

| Column | Required | Handling |
|---|---|---|
| `code_1c` | yes | Position id in 1C; stored as `stocks.source_code` verbatim (trimmed). Never a part number. |
| `name` | yes | `products.title`, whitespace collapsed, text unchanged. |
| `gm_number` | no | One all-digit value → `products.gm_numbers`. |
| `oem_numbers` **or** `manufacturer_part_number` | no | Space-separated → normalized (`normalizeOem`), deduped → `products.oem_numbers`. The current export's `manufacturer_part_number` column is read as OEM numbers; it is never stored as an "MPN" and never as a GM number. |
| `quantity` | yes | Whole number → `stocks.quantity` (integer). A fractional value is rejected, never rounded. |
| `unit` | yes | `шт.`/`шт` → `PCS`, `л`/`литр` → `L` → `stocks.unit`. Anything else is rejected. |
| `price` | yes | Price for one unit, UZS, `490 000,00` format → `stocks.price_uzs` exactly (see Price below). |
| `vehicle_make`, `vehicle_model` | — | See §4. |
| `category_id`, `subcategory_id` | yes | Approved Mator ids, carried through as given (§3). |

Limits: 20 MB file, 50 000 rows.

### Price

The source price is written **exactly as the file provides it**: no markup, no
retail multiplier, no cost-to-retail conversion, no reinterpretation, and no
rounding by the importer. It is parsed as a decimal string (never a float) into
`stocks.price_uzs` and projected unchanged into `catalog_parts.price_uzs`, which
the buyer API returns as `price_uzs`. Only an admin-created sale campaign can
change the displayed price, exactly as for every other part.

`price_uzs` holds 2 decimal places (tiyin). A price with more decimal places is
**rejected**, not rounded. Note: in the 22.09.2026 workbook, 391 price cells
hold more precision than they display (e.g. `195642.855`, `385044.643333`);
Excel's "Save as Text" writes the displayed 2-decimal value (`195 642,86`), and
that text value is what is imported, unchanged.

## 3. How one row is written

| Target | Value |
|---|---|
| `products` (one per `code_1c`) | `title`, `gm_numbers`, `oem_numbers`, `part_number_type`/`is_gm`/`is_oem` (from which lists are populated), `is_universal`, `category_id = subcategory_id`, `vehicle_category_id` = level-0 root of `category_id`, legacy `main_category`/`vehicle_category` enums mirrored only where the ids map to one (never guessed). `gm_number` stays NULL. |
| `stocks` | seller = the linked BUSINESS seller, `source_system = DRIVERS_VILLAGE_1C`, `source_code = code_1c`, `price_uzs` (exact), `quantity` (integer), `unit`. |
| `part_models` | specific models (§4), reconciled on every import. |
| `part_makes` | make-wide rows (§4), reconciled on every import. |
| `catalog_parts` | via the existing projection: seller `drivers-village`, `price_uzs` = the source price, `stock_qty` = quantity, `in_stock` = quantity > 0, number arrays, fits. |

Every 1C position gets its **own** product. Positions are never merged by name
or part number: the export has many positions that share a name and number but
differ in price (different brand or batch), and some numbers even appear on
unrelated parts (left and right shock absorbers, an oil filter and a water
pump). Such groups are listed in the report under `lookAlikes` for review.

## 4. Vehicle compatibility

| Source | Meaning | Stored as |
|---|---|---|
| make + model(s) | specific models | `part_models` rows |
| make, no model | every model of that make | one `part_makes` row, `is_universal = false` |
| neither | every vehicle | `is_universal = true`, no links |
| model without make | invalid | row rejected |

`vehicle_model` is split on `;`, trimmed, blanks dropped, duplicates removed.
A `,`-separated list is rejected (`,` appears inside real codes such as
`MALIBU-1,5-TURBO`).

Codes resolve to the canonical names the app filters on, deterministically:
first the explicit table in `drivers-village-vehicle.mapper.ts`, then an
exact alias in `src/ai/vehicle-catalog.ts` after `-` → space (`NEXIA-3` →
`Nexia 3`). Unknown codes are rejected, never guessed. **Review the table:**
generation codes (`DAMAS-2`, `DAMAS-3-MOVE`, `MALIBU-2`, `CAPTIVA-5`,
`TRACKER-1`) collapse into the base model because the buyer catalog has no
generation level, and `Epica`, `Tacuma`, `Nexia 1` (Chevrolet), SsangYong and
Genesis are outside the canonical catalog. The dry-run lists every mapping
used, with its row count, under `vehicles.mappings`.

## 5. Commands

```bash
# Plan only — parses, matches and validates everything, writes nothing.
npm run import:drivers-village -- /path/to/export.txt --dry-run

# Real import.
npm run import:drivers-village -- /path/to/export.txt
```

`--report-dir=<dir>` changes where reports go (default: next to the input).
Each run writes `drivers-village-<mode>-<timestamp>.json` (full report) and
`…-issues.csv` (one line per problem). Exit code: `0` clean, `2` finished
with rejected/blocked rows or projection failures, `1` aborted.

The report separates **data** issues (fix the export) from **reference**
issues (this database lacks something the row needs, e.g. a category id —
typical on a dev DB, not a source-data problem).

## 6. Re-imports and ownership

- A position is identified by `(seller, DRIVERS_VILLAGE_1C, code_1c)`
  (unique index). Re-importing updates it in place; unchanged rows are not
  rewritten.
- The import owns: title, GM/OEM lists, category ids and mirrors, vehicle
  links, price, quantity, unit.
- The import never touches: product photos and `image_url`, description,
  rating, kind, sale form, sellers, catalog sellers, categories.
- Positions in the database but absent from the file are **listed**
  (`positionsNotInFile`), not changed or deleted.
- Batches of 100 positions, one transaction each. A failed batch rolls back
  alone and stops the run; re-running the same file resumes (committed rows
  plan as unchanged, missing projections are redone).
- Do not run two imports against the same database at the same time.

## 7. Photo updates from Telegram

Any Telegram user who knows a position's `code_1c` can replace its photos:

1. Send 1–10 photos (one photo or an album) with the caption = the exact
   `code_1c`, e.g. `00-00001431` or `БП-01068170`. Case, surrounding spaces and a
   phone's dash look-alikes are normalized; otherwise the match is exact.
2. The bot finds the position **only** by
   `(stocks.seller_id = Driver's Village BUSINESS seller, source_system =
   DRIVERS_VILLAGE_1C, source_code = code_1c)` — never by GM/OEM number. An
   unknown code is answered with a clear message and nothing is written.
3. The photos go through the same pipeline as a new listing (photo-update
   draft → BullMQ worker → FLUX → Cloudinary) and the same preview media, with
   ✅ Confirm / ❌ Cancel.
4. **Confirm** replaces only that product's gallery (first photo primary,
   `products.image_url` = first) and re-projects the stock. Title, numbers,
   fitment, category, price, quantity and source fields never change; no
   product or stock is created. Photos stay attached to that one position,
   because every imported position has its own product.
5. **Cancel** changes nothing in the database; only the preview's temporary
   uploads are deleted.

A caption that is not code-shaped (or no caption) keeps the ordinary listing
wizard exactly as before. Imports never touch photos, so a re-import keeps them.
A later confirm replaces the gallery again; old Cloudinary assets of a replaced
gallery are not deleted (the same as an ordinary re-listing).

## 8. Tests

`npx jest src/imports/drivers-village src/catalog` runs everything without a
database: `test/utils/drivers-village-fake-db.ts` is an in-memory fake of the
Prisma calls the importer makes, with an isolated `drivers-village` fixture.
No seed data is added to any real database.

For a manual end-to-end run on a **non-production** database: apply
migrations, create a `drivers-village` catalog seller, run the §1 setup SQL,
run `npm run seed:categories`, and create any category ids the dry-run still
reports as missing.
