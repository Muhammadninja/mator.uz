# Driver's Village 1C catalog import

Operator runbook for importing Driver's Village stock from its 1C export into
Mator. The importer is a CLI; there is no HTTP endpoint for it.

```
1C export (its ";" file, or Excel → "Tab-delimited Text")
      │  npm run import:drivers-village       — price/stock sync (also the timer)
      │  npm run drivers-village:classify     — prepared classification file (by hand, §9)
      ▼
Product · Stock · part_models / part_makes                     (supply side)
      │  CatalogProjectionService  (the one existing mapping)
      ▼
CatalogPart · catalog_part_fits · catalog_part_make_fits       (buyer catalog)
      ▼
Mator mobile app
```

**Two jobs, kept apart.** The import (§2–§6) **synchronizes** what 1C owns:
it creates positions 1C has and Mator does not, and for a position that
exists it writes only the stock **price** and — when the file has a
`quantity` column — the **quantity**. It never changes a stored position's
name, numbers, unit, vehicles, category, photos or catalog settings. The
**classification import** (§9) applies a prepared file of categories and
vehicles; it never touches prices or stock and is never run by the timer.

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
| `code_1c` | yes | Position id in 1C **and the manufacturer part number** of a new position (business rule, 2026-10-18). Stored verbatim — trimmed only; case, leading zeros and every character kept — as `stocks.source_code` and, when the position is created, `products.source_part_number` (a stored part number is never changed by the sync; a difference is reported, `notApplied: part_number`). Its search form (`normalizeOem`: uppercase, separators dropped, leading zeros kept) → `products.oem_numbers` of a new position when it is a plausible number (Latin letters, digits, `.-/`, single spaces, 3–50 characters); otherwise it is only reported (`oem_not_indexed`). Its 8-digit key may follow (§6). Accepted shapes and rejections: "Is `code_1c` an article?" below. |
| `name` | yes | `products.title`, whitespace collapsed, text unchanged. |
| `gm_number` | no | One all-digit value → `products.gm_numbers`. |
| `manufacturer_part_number`, `oem_numbers` | no | **Never imported**, whatever they hold — the part number is `code_1c`. These cells carry unreliable values (brand and model names such as `SKODA`, `Onix`). Listed under `headers.notImported`; a file may carry both. |
| `quantity` | no | The on-hand count: whole number → `stocks.quantity` (integer), read in the file's number format: `2,268` in the `;` export is 2268. A fractional (`12.5`, `1,234.5`) or negative (`-3`) value is rejected, never rounded. **No column or an empty cell** = not given: a new stock gets the column default `stocks.quantity DEFAULT 1`, an existing stock keeps its count. A repeated `code_1c` whose rows state different quantities gives no confirmed count either (see "Repeated `code_1c`"). |
| `unit` | yes | `шт.`/`шт`/`штук` → `PCS`, `л`/`литр` → `L` → `stocks.unit`. Anything else (`1`, `комп.`) is rejected. |
| `price` | yes | Price for one unit → `stocks.price_uzs` through the price rule (see Price below). |
| `vehicle_make`, `vehicle_model` | — | See §4. |
| `category_id`, `subcategory_id` | no | **Never read by this import**, whatever they hold (blank cells and unknown ids are fine). Categories are assigned in Mator or by the classification import (§9). The report lists them under `headers.notImported`. |

Limits: 20 MB file, 50 000 rows. The export's other columns (`currency`,
`brand`, `description`, `photo_urls`, `vehicle_generation`, `vehicle_trim`,
`engine`, `year_from`, `year_to`) are listed under `headers.ignored` and never
read.

### Is `code_1c` an article?

Profiled on the three real exports (2026-09-19 … 2026-10-18, ~4 300 rows each),
`code_1c` holds 8-digit GM-style numbers, 10- and 13-digit numbers,
dash-separated articles (`5Q0-615-301-F`), 1C codes (`_00-00001431`,
`_БП-01068170`; a trailing `-`/`--` marks a separate 1C position) and numbers
with suffixes. Numeric codes are valid as such, and so are articles of
letters, digits, hyphens and **single spaces** (`SCT SB 061-0868`,
`K0000049 H6`, `PFA 235`), with `&`, `+` and balanced parentheses inside a
token (`94583379S&T`, `96273708PMC(EU)`, `4260360943454 12+`) — rule
`code1cIssue` in `drivers-village-code-key.ts`, shared with the Telegram
photo captions. Every code accepted before 2026-10-19 stays accepted. Rejected,
never altered (so two different codes never become one):

- irregular whitespace — two spaces, a tab, a no-break space
  (`847GPUMPT   90231`) — and any other symbol (`RXA06820 ,`, `Шина 195\60`):
  `invalid_code_1c`;
- a product **name** in the code column — several words with a Russian word
  (`Фильтр топливного насоса`, `Аккумуляторные батареи марки KLAS N`) or
  without any digit (`Castrol EDGE`): `name_as_code_1c`. Trade names with a
  digit (`Mobil Super 3000`, `Gentra R3`) cannot be told from articles and are
  accepted — review them in 1C.

Two more rules guard against values that are not articles:

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
  wins. A new position takes its name, unit and `gm_number` from that row
  (`code_1c`, and with it the part number, is the same on all rows) and the
  **vehicles of all its valid rows, merged** — a model listed only on a
  cheaper row is not lost. The other rows are `merged`: reported, never
  written, so a later row with a lower price cannot overwrite the highest one.
- Rows of one code often differ in quantity (521 repeated codes in the
  2026-10-18 export: likely different batches or warehouses) and sometimes in
  name. Different quantities give **no confirmed count**: none is written (a
  new stock starts at the default 1, a stored one keeps its count) — never one
  row's quantity, never a sum. The chosen row carries a warning to review —
  `duplicate_quantities_differ` and/or `duplicate_names_differ`; the report
  counts `codesWithAmbiguousQuantity`.
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

A **new** position (no stock with its exact code yet) is created:

| Target | Value |
|---|---|
| `products` (one per `code_1c`) | Allowlist only (`importOwnedProductData`): `title`, `source_part_number` (= `code_1c`, verbatim), `gm_numbers`, `oem_numbers`, `part_number_type`/`is_gm`/`is_oem` (from which lists are populated). **No category** — `category_id`, `vehicle_category_id`, `main_category`, `vehicle_category` start NULL. `gm_number` stays NULL, `is_universal` false. |
| `stocks` | seller = the linked BUSINESS seller, `source_system = DRIVERS_VILLAGE_1C`, `source_code = code_1c`, `price_uzs` (normalized, §2), `quantity` (integer; omitted when the file gives none — see §2; `0` is written as 0), `unit`. |
| `part_models` / `part_makes` | the vehicles of the code's rows (§4), added once. |
| `catalog_parts` | the full projection: seller `drivers-village`, `price_uzs`, `stock_qty` = quantity, `in_stock` = quantity > 0, number arrays, fits; category `cat_uncategorized`. |

A **stored** position (found by its exact `(seller, DRIVERS_VILLAGE_1C,
code_1c)`) is synchronized, nothing more:

| Target | Value |
|---|---|
| `stocks` | `price_uzs` when it changed; `quantity` only when the file states one (§2) and it changed. |
| `catalog_parts` | only the columns those feed (`CatalogProjectionService.projectStockLevels`): `price_uzs` when the price changed, `stock_qty` / `in_stock` when the quantity changed. A retail price or stock count an operator set stays when the file does not change it. |
| everything else | **never written**: name, part number, OEM/GM lists, unit, `part_models` / `part_makes` / `catalog_part_fits` (not deleted, not recreated), category, photos, rating, kind, sale form, `fitment_bindings`, purchase price, cashback. Where the file differs, the row lists it under `notApplied` (`name`, `unit`, `gm_number`, `part_number`, `vehicles`); the dry-run counts `rowsWithCardDifferences`. |

Every 1C position gets its **own** product. Positions are never merged by name
or part number: the export has many positions that share a name and number but
differ in price (different brand or batch), and some numbers even appear on
unrelated parts (left and right shock absorbers, an oil filter and a water
pump). Such groups are listed in the report under `lookAlikes` for review.

## 4. Vehicle compatibility

Vehicles are written when a position is **created** (the sync never changes
the vehicles of a stored position; the classification import adds to them,
§9):

| Source | Meaning | Stored as |
|---|---|---|
| make + model(s) | specific models | `part_models` rows |
| make, no model | every model of that make | one `part_makes` row, `is_universal = false` |
| neither | **no information** | no links; `is_universal` stays false — an empty cell never makes a part universal |
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
with rejected rows or projection failures, `1` aborted, `3` another import
holds the import lock (nothing was done).

The report separates **data** issues (fix the export) from **reference**
issues (this database lacks something the row refers to, e.g. a vehicle name
or the linked seller — typical on a dev DB, not a source-data problem).

## 6. Re-imports and ownership

- A position is identified by its **exact** `(seller, DRIVERS_VILLAGE_1C,
  code_1c)` (unique index) — never by name, part number, a normalized form or
  a key — and looked up again by that key at write time. Re-importing
  synchronizes it in place (§3); unchanged rows are not rewritten, so a
  repeated file creates no duplicates and writes nothing.
- **A code that changed in 1C is a new position.** The 8-digit key of a code
  (the one run of exactly 8 digits: `96273708`, `96273708 GMB`,
  `GMB 96273708`, `96273708-OEM`; never cut out of `123456789`,
  `drivers-village-code-key.ts`) never makes one code write another code's
  position: a marker is often another brand (`96273708PMC(EU)`,
  `94583379S&T`), so a takeover could put one part's price on another. A new
  code that shares its key with other codes is created as a position of its
  own and reported (`code_key_shared`, `keyShared`,
  `rowsToCreateWithSharedKey`); where the key ties it to a stored code as the
  bare article and the article with a marker (`96273708` ↔ `96273708 GMB`),
  the stored code is listed as a **possible rename** (`possibleRenameOf`,
  `rowsWithPossibleRename`) — the stored position keeps its price, photos and
  category and stays listed under `positionsNotInFile`; an operator decides.
- **The search index of a new position.** `oem_numbers` holds the normalized
  `code_1c` (`96273708 GMB` → `96273708GMB`) and, after it, the 8-digit key
  (`96273708`) — the key only while no other position of the seller carries
  the same value as its key or normalized code: `oem_numbers` also binds 1C
  stock uploads (`sync-inventory` takes the first part with the article), so
  a shared value could send one position's stock to another. A stored
  position's index is never changed. A new code whose own search number
  another position already carries (`PFA 235` next to `PFA 235-`, or
  `96273708` next to a stored `96273708 GMB` indexed by its key) stays a
  separate position and is reported (`oem_index_shared`).
- **Check which export you import.** The rule needs `code_1c` to be the
  article. A file whose `code_1c` holds row numbers is refused as a whole
  (§2, "Is `code_1c` an article?").
- The sync owns, for a stored position: price and quantity (only when the
  file gives one). Everything else of a stored position belongs to Mator.
- **Classification.** The sync never writes a category. New positions arrive
  unclassified (`catalog_parts.category_id = 'cat_uncategorized'`; the
  dry-run counts them as `newWithoutCategory`) and are classified in the
  admin console (inventory filter `categoryId=cat_uncategorized`, then
  `PATCH /v1/admin/products/bulk-move`) or by the classification import
  (§9). That category survives every later import, photo update and rating
  edit. `existingWithoutCategory` counts positions still waiting.
- The sync never touches: categories, vehicle links, product photos and
  `image_url`, description, rating, kind, sale form, sellers, catalog
  sellers, and the admin-maintained `catalog_parts` columns (purchase price,
  cashback, low-stock threshold, fitment bindings).
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
   exact code wins; otherwise the 8-digit key rule (`keyProvesSamePart`)
   applies, so the bare article and the article with a marker find each other
   (`96273708` ↔ `96273708 GMB`). An unknown code, a code whose key links several positions
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
Prisma calls the importers make, with an isolated `drivers-village` fixture,
and `test/utils/drivers-village-fake-catalog.ts` lets
`drivers-village-sync.spec.ts`, `drivers-village-sync-scope.spec.ts` (what a
sync may write to a stored position; codes) and
`drivers-village-classification.spec.ts` (§9) run the real catalog projection
on top of it (repeated exports, manual categories, absent rows, dry run). The price rule
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

## 9. Classification import (categories and vehicles from a prepared file)

A prepared file (e.g. `final_1c.txt`: `code_1c`, `category_id`,
`subcategory_id`, `vehicle_make`, `vehicle_model`; any other column is
ignored, so prices and stock never change) is applied to positions the sync
created. It is run **by an operator only** — the Telegram ingest timer runs
the sync CLI and nothing else.

```bash
# Dry run (the default): plans everything, writes nothing, prints the
# confirmation code of exactly this file.
npm run drivers-village:classify -- /path/to/final_1c.txt

# Apply exactly the reviewed file (the code is the first 12 hex characters of
# its SHA-256; a changed file needs a new dry run).
npm run drivers-village:classify -- /path/to/final_1c.txt --apply --confirm=<code>
```

Reports: `drivers-village-classification-<mode>-<timestamp>.json` and
`…-issues.csv` next to the file (or `--report-dir=<dir>`); `--encoding=` as
in §5. Exit code: `0` nothing to review, `2` finished with warnings in the
report, `1` aborted or refused, `3` another import holds the lock.

Rules (`drivers-village-classification.rules.ts`):

- **Positions are found by their exact `code_1c` and never created**
  (`position_not_found`); rows of one code are merged.
- **Who classified a position is not recorded.** The admin console writes
  `catalog_parts.category_id` and the `main_category` / `vehicle_category`
  derived from it (bulk-move, a category delete with reassignment) without an
  audit row, and maintenance scripts write the same
  column, so an operator's choice cannot be told from another one. Every
  category already on a catalog part is therefore kept as if an operator set
  it, whatever the file says (`manual_category_preserved`, with the ignored
  file value). The file's category is applied only when the position is not
  classified (its part sits in `cat_uncategorized`) — or **below** the stored
  category (`category_refined`: the stored level is kept, the subcategory is
  filled in). Replacing a category set in Mator is an operator action in
  Mator, never the import.
- The category must exist in `part_categories` and be active with every
  ancestor, and `category_id` must be the subcategory's ancestor; otherwise
  nothing changes (`category_unknown`, `category_inactive`,
  `category_mismatch` — e.g. `engine` where the tree has `engine-system`,
  `category_fallback`). Rows of one code giving different categories:
  `category_conflict`. Categories are never created. The report groups these
  under `categoryProblems` — fix the file and run the dry run again.
- The category goes to `products` (`category_id` = the node,
  `vehicle_category_id` = its root, the `main_category` / `vehicle_category`
  mirrors) and through the projection (`projectClassification`) to
  `catalog_parts` — only while the part still has the category it had when
  planning, so an operator's change made meanwhile wins
  (`category_changed_meanwhile`).
- **Vehicles are only added** to `part_models` / `part_makes` and the
  catalog fits — none is removed, empty cells change nothing, unknown models
  are reported. A product the old import marked universal (from empty cells;
  no admin path sets that flag) becomes specific when the file names its
  vehicles (`universal_cleared`). `fitment_bindings` (Fitment Studio) are
  never written; a part that has them is flagged `curated_fitment_present`
  (buyer fitment uses the bindings first).
- Never written: prices, stock, names, numbers, photos, rating, catalog
  settings. Applying the same file again writes nothing.
