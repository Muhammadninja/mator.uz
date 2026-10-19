# Driver's Village 1C catalog import

Operator runbook for importing Driver's Village stock from its 1C export into
Mator. The importer is a CLI; there is no HTTP endpoint for it.

```
1C export (its ";" file, or Excel → "Tab-delimited Text")
      │  npm run import:drivers-village
      ▼
Product · Stock · part_models / part_makes                     (supply side)
      │  CatalogProjectionService.projectStock  (the one existing mapping)
      ▼
CatalogPart · catalog_part_fits · catalog_part_make_fits       (buyer catalog)
      ▼
Mator mobile app
```

Code: `src/imports/drivers-village/`, CLI: `scripts/import-drivers-village.ts`,
migrations: `prisma/migrations/20260923000000_drivers_village_1c_import`,
`prisma/migrations/20261009000000_drivers_village_source_part_number`.
Exports that 1C sends to Telegram are picked up and run through this same CLI
automatically: [DRIVERS_VILLAGE_TELEGRAM_INGEST.md](DRIVERS_VILLAGE_TELEGRAM_INGEST.md).

## 1. Prerequisites (per database)

| Requirement | Why | Dry-run reports it as |
|---|---|---|
| Migrations `20260923000000_drivers_village_1c_import` and `20261009000000_drivers_village_source_part_number` applied | add seller type, source identity on stocks, number lists, make-wide fitment tables, `products.source_part_number` | `schema_not_migrated` |
| Catalog seller `drivers-village` exists | every position is listed under this dealer | `catalog_seller_missing` |
| A **BUSINESS** seller linked to it | `stocks.seller_id` points at a supply-side `sellers` row; the importer never creates one | `linked_seller_missing` / `linked_seller_not_business` |

A real import refuses to start while any of these is unmet and writes nothing.
No category data is required: the import never writes a category (§6).

### Deploy order

1. Apply the migrations with `npx prisma migrate deploy`:
   `20260923000000_drivers_village_1c_import`, then
   `20260923010000_drivers_village_photo_updates`, then
   `20261009000000_drivers_village_source_part_number` (one nullable column,
   additive; the new client selects it, so it must precede the code).
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

Two formats are read; the **delimiter is detected from the header row**, and
the way numbers are written follows from it:

| Format | Delimiter | Numbers | Typical file |
|---|---|---|---|
| 1C's own export (main format) | `;` | `1,234,567.89` — commas group thousands strictly in threes, a dot separates decimals | `dv_parts_2026_10_18.txt`: UTF-8 with BOM, CRLF, a stray BOM as the last line |
| Excel → **File → Save As → "Tab-delimited Text (.txt)"** | tab | `1 234 567,89` — spaces group thousands, a comma (or a dot) separates decimals | Mac Cyrillic, Windows-1251 or UTF-8 |

- The delimiter is the one that splits the header into the required columns
  (`code_1c`, `name`, `unit`, `price`, `vehicle_make`, `vehicle_model`).
  A header that works with both delimiters is **refused as ambiguous**; a
  header with neither is refused too; with one delimiter but missing columns,
  the abort names them. Nothing is written in either case.
- Columns are found by name, in any order (the order changed between the
  2026-09-19 and 2026-10-08 exports).
- A number that does not fit its format is **rejected, never guessed**: in the
  `;` export `12,34` or `1,5` (a comma that does not start a group of three)
  and in the tab text `1,600,000` (two separators).
- A row with more non-empty cells than the header (a delimiter inside an
  unquoted value shifted the columns) is rejected (`column_shift`) — none of
  its cells is trusted.
- `.xlsx` is not read directly. The encoding is detected (UTF-8, Mac Cyrillic,
  Windows-1251); force it with `--encoding=utf-8|x-mac-cyrillic|windows-1251`.

| Column | Required | Handling |
|---|---|---|
| `code_1c` | yes | Position id in 1C **and the manufacturer part number** (business rule, 2026-10-18). Stored verbatim — trimmed only; case, leading zeros and every character kept — as `stocks.source_code` and `products.source_part_number`, on create and on every update (a wrong stored number is corrected by the next import). Its search form (`normalizeOem`: uppercase, separators dropped, leading zeros kept) → `products.oem_numbers` when it is a plausible number (Latin letters, digits, `.-/`, single spaces, 3–50 characters); otherwise it is only reported (`oem_not_indexed`). Its 8-digit key may follow (§6). Letters, digits and `. _ / -`, plus single spaces in an 8-digit article with a marker (`96273708 GMB`, `GMB 96273708` — kept as is, space included; indexed as `96273708GMB`, plus the key, §6). Any other whitespace or symbol (`БП 010`, `96810038S&T`) is rejected (`invalid_code_1c`), never altered. See "Is `code_1c` an article?" below and the 8-digit key in §6. |
| `name` | yes | `products.title`, whitespace collapsed, text unchanged. |
| `gm_number` | no | One all-digit value → `products.gm_numbers`. |
| `manufacturer_part_number`, `oem_numbers` | no | **Never imported**, whatever they hold — the part number is `code_1c`. These cells carry unreliable values (brand and model names such as `SKODA`, `Onix`). Listed under `headers.notImported`; a file may carry both. |
| `quantity` | no | Whole number → `stocks.quantity` (integer), read in the file's number format: `2,268` in the `;` export is 2268. A fractional (`12.5`, `1,234.5`) or negative (`-3`) value is rejected, never rounded. **No column or an empty cell** = not given: a new stock gets the column default `stocks.quantity DEFAULT 1`, an existing stock keeps its count. |
| `unit` | yes | `шт.`/`шт`/`штук` → `PCS`, `л`/`литр` → `L` → `stocks.unit`. Anything else (`1`, `комп.`) is rejected. |
| `price` | yes | Price for one unit → `stocks.price_uzs` through the price rule (see Price below). |
| `vehicle_make`, `vehicle_model` | — | See §4. |
| `category_id`, `subcategory_id` | no | **Never imported**, whatever they hold (blank cells and unknown ids are fine). Categories are assigned in Mator (§6). The report lists them under `headers.notImported`. |

Limits: 20 MB file, 50 000 rows. The export's other columns (`currency`,
`brand`, `description`, `photo_urls`, `vehicle_generation`, `vehicle_trim`,
`engine`, `year_from`, `year_to`) are listed under `headers.ignored` and never
read.

### Is `code_1c` an article?

Profiled on the three real exports (2026-09-19 … 2026-10-18, ~4 300 rows each),
`code_1c` holds 8-digit GM-style numbers, 10- and 13-digit numbers,
dash-separated articles (`5Q0-615-301-F`), 1C codes (`_00-00001431`,
`_БП-01068170`) and numbers with suffixes. Numeric codes are valid as such. Two
rules guard against values that are not articles:

- **Placeholders** — a code that is one character repeated (`1`, `B`, `3333`,
  `222222`) is rejected (`placeholder_code_1c`). In the exports these codes are
  shared by unrelated goods (`1`: 22 rows, 22 different names; `3333`: 10 rows,
  7 names); importing them would merge different parts into one position.
- **Row numbers** — if at least half of the rows (and at least 10) carry
  distinct whole numbers no larger than the number of rows (`1…1515` in any
  order), the column holds row numbers and the **whole file is refused**:
  nothing is written, also in a dry run. Real exports have at most 9 such
  values (`294`, `650` …); long numeric articles always exceed the row count,
  so they can never trigger it.

### Price

1C writes some prices in thousands of UZS. The rule (business decision,
2026-10-15), implemented once in `drivers-village-price.ts`
(`normalizeSourcePrice`):

| Source cell | Rule | `price_uzs` |
|---:|---|---:|
| tab text: `690` · `6,5` · `320,65` · `530,560` · `999,999` | below 1000 → thousands, ×1000 | `690000` · `6500` · `320650` · `530560` · `999999` |
| tab text: `1000` · `12 500` · `490 000,00` | 1000 and above → UZS as is | `1000` · `12500` · `490000` |
| `;` export: `140` · `123.45` | below 1000 → thousands, ×1000 | `140000` · `123450` |
| `;` export: `1,234` · `123,456` · `1,100,000` | 1000 and above → UZS as is | `1234` · `123456` · `1100000` |

- The cell is read in the file's number format (above): in the tab text the
  comma is the decimal separator and spaces, NBSP and thin spaces group
  thousands, so a cell with two separators (`1,600,000`, `1.234,56`) is
  rejected; in the `;` export commas group thousands, so `1,100,000` is
  1100000 and `12,34` is rejected. The importer never guesses.
- Exact decimal arithmetic (`Prisma.Decimal`), never a float, and **no
  rounding**: the result must fit `price_uzs` (2 decimals). A price in
  thousands may have up to 5 decimals, a price in UZS up to 2; more is
  rejected.
- The rule is applied to the **source cell of every export**, never to a
  stored price. Re-importing the same file gives the same price; nothing is
  ever multiplied twice.
- Empty, zero, negative or malformed prices reject the row (`invalid_price`,
  with the reason). A rejected row writes nothing: the stored price (and
  quantity) stay as they are. For a `code_1c` on several rows see
  "Repeated `code_1c`" below.
- Warnings (the row is still imported): `price_jump` — the new price is 100×
  or more above/below the stored one, the signature of a wrong scale (also
  expected once for a price stored unscaled before this rule);
  `price_below_1000_uzs` — a source below 1 (e.g. `0,5` → 500 UZS).
- The report shows per row `price: { source, scaled, from, to }`, samples of
  both cases under `prices.examples`, and the counts `rowsWithScaledPrice` /
  `rowsWithPriceChange`.

The rule applies only to this `price` column. The 1C stock sync endpoint
(`POST /v1/integrations/dealers/sync-inventory`) writes the purchase price
(`catalog_parts.purchase_price_uzs`) and is not affected.

### Repeated `code_1c`

A `code_1c` on several rows (one part listed per batch, at different prices)
is **one** position (`resolveDuplicateCodes` in `drivers-village.planner.ts`):

- It is written once, at the **highest valid price** among its rows: each
  price goes through the rule above, then the results are compared exactly
  (`Prisma.Decimal`, no rounding). On a tie the **first** such row in the file
  wins. **Every** import-owned field is taken from that one row — price,
  quantity, name, unit, `gm_number` and vehicles (`code_1c`, and with it the
  part number, is the same on all rows). Quantities are **never summed** and
  never taken from another row of the group. The other rows are `merged`:
  reported, never written, so a later row with a lower price cannot overwrite
  the highest one.
- Rows of one code often differ in quantity (574 of 625 repeated codes in the
  2026-10-18 export: likely different batches or warehouses) and sometimes in
  name (49). The chosen row then carries a warning to review —
  `duplicate_quantities_differ` (the quantities, and the one imported) and/or
  `duplicate_names_differ` — while the rule above still decides.
- Only rows that pass every check compete. A row whose only error is its price
  is `merged` with that error downgraded to a warning; a row rejected for
  anything else stays `rejected` and never feeds the database.
- If no row of the code has a valid positive price, nothing is written for it
  (`no_valid_price` on each row): a stored price is never replaced by zero or
  an invalid value.
- The report lists every repeated code under `duplicates` (rows, lines, chosen
  line and price, and `differs` — the fields in which its valid rows
  disagree), with the counts `duplicateSourceCodes`, `duplicateCodesMaxPrice`,
  `rowsMerged` and `codesWithoutValidPrice` (the last also counts codes on a
  single row). The console shows the first 15.

## 3. How one row is written

| Target | Value |
|---|---|
| `products` (one per `code_1c`) | Allowlist only (`importOwnedProductData`): `title`, `source_part_number` (= `code_1c`, verbatim), `gm_numbers`, `oem_numbers`, `part_number_type`/`is_gm`/`is_oem` (from which lists are populated), `is_universal`. **No category** — a new product is created with `category_id`, `vehicle_category_id`, `main_category`, `vehicle_category` all NULL. `gm_number` stays NULL. |
| `stocks` | seller = the linked BUSINESS seller, `source_system = DRIVERS_VILLAGE_1C`, `source_code = code_1c`, `price_uzs` (normalized, §2), `quantity` (integer; omitted when the file gives none — see §2; `0` is written as 0), `unit`. |
| `part_models` | specific models (§4), reconciled on every import. |
| `part_makes` | make-wide rows (§4), reconciled on every import. |
| `catalog_parts` | via the existing projection: seller `drivers-village`, `price_uzs` = the normalized price, `stock_qty` = quantity, `in_stock` = quantity > 0, number arrays, fits. A new part lands in `cat_uncategorized`; for an imported position `category_id` / `main_category` / `vehicle_category` are written **on create only**, so a category set in the admin survives every later projection. |

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

`vehicle_model` lists every model the part fits: it is split on `,` (the
export's separator) or `;`, trimmed, blanks dropped, duplicates removed. The
row stays **one** product with one `part_models` row (and one
`catalog_part_fits` row) per model, e.g. `DAMAS-2, LABO` → Damas + Labo.
Model codes never contain `,` or `;`.

Codes resolve to the canonical names the app filters on, deterministically:
first the explicit table in `drivers-village-vehicle.mapper.ts` (a space and a
`-` are the same separator there: `CAPTIVA 5` = `CAPTIVA-5`), then an exact
alias in `src/ai/vehicle-catalog.ts`, as written (`H-1`) or after `-` → space
(`NEXIA-3` → `Nexia 3`). Unknown codes are rejected, never guessed — e.g.
`TICO` under `CHEVROLET` (Tico is Daewoo's: set `vehicle_make` to `DAEWOO`) or
a bare `NEXIA` (no generation). **Review the table:** generation codes
(`DAMAS-2`, `DAMAS-3-MOVE`, `MALIBU-2`, `CAPTIVA-5`, `TRACKER-1`, `TRACKER-2`,
`TAHOE-2`) collapse into the base model because the buyer catalog has no
generation level, and `Epica`, `Tacuma`, `Nexia 1`, `Monza` (Chevrolet),
`Niva`, `Largus` (Lada), SsangYong and Genesis are outside the canonical
catalog. The dry-run lists every mapping used, with its row count, under
`vehicles.mappings`.

The garage filter matches fit rows by make and model **name**. The dry-run
reads this database's `vehicle_makes` / `vehicle_models` (read-only) and lists
every fit with no same-named row under `vehicles.notInBuyerReference` (warning
`vehicle_not_in_reference`). Such a fit is still written; it matches no garage
vehicle until the reference has that name.

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
with rejected rows, 8-digit key conflicts or projection failures, `1`
aborted, `3` another import holds the import lock (nothing was done).

The report separates **data** issues (fix the export) from **reference**
issues (this database lacks something the row refers to, e.g. a vehicle name
or the linked seller — typical on a dev DB, not a source-data problem).

## 6. Re-imports and ownership

- A position is identified by `(seller, DRIVERS_VILLAGE_1C, code_1c)`
  (unique index) — never by name or part number; a stored part number is
  only compared with `code_1c` to see whether it needs correcting.
  Re-importing updates a position in place; unchanged rows are not rewritten,
  so a repeated file creates no duplicates. The dry-run counts the corrections
  as `rowsWithPartNumberChange` (per row: `partNumber: { from, to }`).
- **A changed code_1c is found by its 8-digit key — only where that proves
  one part.** A code with exactly one run of exactly 8 digits (`96273708`,
  `96273708 GMB`, `GMB 96273708`, `96273708-OEM`; never cut out of
  `123456789`) has that run as its key (`drivers-village-code-key.ts`). Only
  `stocks.source_code` values are compared — never a stored part number, OEM
  list or the name — and nothing extra is stored. Eight equal digits alone
  prove nothing: the key is evidence only between the **bare article** and
  the **article with a marker** (`96273708` ↔ `96273708 GMB`, either way).
  An exact `code_1c` always updates its own position. A code without a
  position of its own:

  | Situation | Result |
  |---|---|
  | The file's only code with the key, one position stored with it, and one of the two codes is the bare article | That position is updated by the usual rules and takes the new code (`source_code`, part number, verbatim). Warning `code_key_match`, `keyMatches`, `rowsMatchedByKey`. |
  | No stored position it could provably be: none with the key, all of them belong to other codes of the file, a marker replaced by another (`96273708 GMB` → `96273708 OEM`) or another 1C series (`00-00001431` → `БП-00001431`) | A new position of its own, as before; the stored positions stay as they are. Warning `code_key_shared`, `keyShared`, counted in `rowsToCreateWithSharedKey`. Nothing is merged. |
  | A provable takeover with rivals: several positions stored with the key, or several codes of the file with it | Outcome `conflict`, error `code_key_conflict`, `keyConflicts`: nothing is written for those codes and no stored position changes. Resolve the codes in 1C (or the positions by hand) and re-import. |

  Review `keyMatches`, `keyShared` and `keyConflicts` in the dry-run before
  the real import.
- **The key in the OEM search index.** `oem_numbers` holds the normalized
  `code_1c` (`96273708 GMB` → `96273708GMB`) and, after it, the 8-digit key
  (`96273708`) — so the buyer search (`normalizeOem(q)`, exact `has`) finds
  the part by the article and by the full code, also after a takeover. The
  key is added only while no other position of the seller carries the same
  value as its key or normalized code: `oem_numbers` also binds 1C stock
  uploads (`sync-inventory` takes the first part with the article), so a
  shared value could send one position's stock to another. A shared key is
  therefore on no position key-only — the bare article keeps it as its own
  code, the others are found by their full code — and a key that becomes
  shared leaves the index of a position in the file. A value is never listed
  twice.
- **Check which export you import.** The rule needs `code_1c` to be the
  article. A file whose `code_1c` holds row numbers is refused as a whole
  (§2, "Is `code_1c` an article?"); for anything subtler, the dry-run's
  `Part number replaced by code_1c` examples show what would change.
- The import owns: title, part number (`code_1c`), GM/OEM lists, vehicle
  links, price, quantity (only when the file gives one), unit.
- **Mator owns classification.** The import never writes a category. New
  positions arrive unclassified (`catalog_parts.category_id =
  'cat_uncategorized'`; the dry-run counts them as `newWithoutCategory`) and
  are classified in the admin console (inventory filter
  `categoryId=cat_uncategorized`, then `PATCH /v1/admin/products/bulk-move`).
  That category survives every later import, photo update and rating edit.
  `existingWithoutCategory` counts positions still waiting.
- The import never touches: categories, product photos and `image_url`,
  description, rating, kind, sale form, sellers, catalog sellers, and the
  admin-maintained `catalog_parts` columns (purchase price, cashback, low-stock
  threshold, fitment bindings).
- Positions in the database but absent from the file are **listed**
  (`positionsNotInFile`), not changed, zeroed or deleted — also when the file
  is empty or cut short. Quantity `0` keeps the position (out of stock).
- Batches of 100 positions, one transaction each. A failed batch rolls back
  alone and stops the run; re-running the same file resumes (committed rows
  plan as unchanged, missing projections are redone).
- Two imports never run at the same time on one host: a real import holds the
  lock file `DV_IMPORT_LOCK_FILE` (default
  `/tmp/mator-drivers-village-import.lock`), and a second one — manual or
  from the Telegram ingest — exits `3` without touching the database. A lock
  is **never** removed because of its age; it is replaced only when its holder
  is provably gone (its process is dead, it predates the last reboot, or its
  pid now belongs to another process). A lock from another host or one that
  cannot be read stays until an operator removes it. Do not run imports
  against the same database from another machine.
- A dry run reads only. `drivers-village-dry-run.spec.ts` runs the production
  store over a recording Prisma stand-in: every call is a `find…` or a
  `SELECT`, never a transaction, `create`/`update`/`upsert`/`delete` or
  `$executeRaw`; the same recorder sees the writes of a real import.

## 7. Photo updates from Telegram

Any Telegram user who knows a position's `code_1c` can replace its photos:

1. Send 1–10 photos (one photo or an album) with the caption `1C <code_1c>`,
   e.g. `1C 87654321` or `1C 96273708 GMB` (`1С` with a Cyrillic С, any case,
   and `1C: …` work too). A legacy code such as `00-00001431` or `БП-01068170`
   still works alone, without `1C`. The code must pass the importer's own
   code_1c rule (`code1cIssue`). Spaces, NFKC forms and a phone's dash
   look-alikes are normalized; otherwise the code is matched exactly as
   stored, case included (only a legacy code is uppercased).
2. The bot finds the position **only** by
   `(stocks.seller_id = Driver's Village BUSINESS seller, source_system =
   DRIVERS_VILLAGE_1C, source_code = code_1c)` — never by GM/OEM number. The
   exact code wins; otherwise the importer's 8-digit key rule applies, so the
   bare article and the article with a marker find each other (`96273708` ↔
   `96273708 GMB`). An unknown code, a code whose key links several positions
   (they are listed) and a `1C` caption without a valid code are each answered
   with a clear message: nothing is written and the photos never go to the
   listing wizard.
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

A caption without `1C` that is not a legacy code (or no caption) keeps the
ordinary listing wizard exactly as before. Imports never touch photos, so a re-import keeps them.
A later confirm replaces the gallery again; old Cloudinary assets of a replaced
gallery are not deleted (the same as an ordinary re-listing).

## 8. Tests

`npx jest src/imports/drivers-village src/catalog` runs everything without a
database: `test/utils/drivers-village-fake-db.ts` is an in-memory fake of the
Prisma calls the importer makes, with an isolated `drivers-village` fixture,
and `test/utils/drivers-village-fake-catalog.ts` lets
`drivers-village-sync.spec.ts` run the real catalog projection on top of it
(repeated exports, manual categories, absent rows, dry run). The price rule
has its own table-driven spec, `drivers-village-price.spec.ts`. The `;`
export is covered by `drivers-village-dv-parts.spec.ts` over
`test/fixtures/drivers-village/dv-parts-2026-10-18.anonymized.txt` (the real
file's byte layout with invented rows reproducing its problem cases) and by
`drivers-village-source-format.spec.ts` (delimiter detection, both number
formats, placeholders, shifted columns). `drivers-village-dry-run.spec.ts`
proves that a dry run issues reads only, and `import-lock.spec.ts` runs real
concurrent and killed processes against the lock. No seed data is added to
any real database.

For a manual end-to-end run on a **non-production** database: apply
migrations, create a `drivers-village` catalog seller and run the §1 setup
SQL.
