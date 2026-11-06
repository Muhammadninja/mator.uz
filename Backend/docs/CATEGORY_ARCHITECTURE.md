# Category & Subcategory Architecture

> Scope: how the part-category tree is modeled, how a Telegram-bot listing is
> classified into it, and how the buyer app reads it. Spans `mator.uz/Backend`
> (NestJS + Prisma) and `matorui` (Expo). Snapshot — file paths are stable,
> line numbers may drift.

## One-liner

There is **one** category table (`PartCategory`). Every part always carries a
coarse **`mainCategory`** enum (the home-grid *bucket*) and a precise
**`categoryId`** (the browse-tree *node*, ideally a subcategory). The home grid
counts by the former; the browse drill navigates the latter — so the two views
never disagree.

---

## 1. Data model — one tree

Everything is rows in **`PartCategory`** (`prisma/schema.prisma`), self-referencing
via `parentId`, with a derived `level`:

| Field | Purpose |
|---|---|
| `id` | PK **and** slug (id === slug; slug-shaped, admin `slugify` strips non-`[a-z0-9]`) |
| `name` | **internal** canonical label (slug derivation, ordering, logs) — not shown to users |
| `name_ru` / `name_uz` / `name_en` | the display names, one per shipped language. **All three `NOT NULL`** (migration `20260818000000_category_i18n_and_seller_lang` renamed `title_ru`/`title_uz` into the first two and backfilled `name_en` from `name`) |
| `parentId` | tree edge (self-relation `PartCategoryTree`) |
| `level` | **derived** root=0 → child=parent.level+1; never client-supplied |
| `sortOrder` | sibling order (home grid = importance order) |
| `mainCategory` | `PartMainCategory?` — **set only on the 12 buckets**; null on roots/subs |
| `iconKey`, `color` | home-grid presentation (buckets) |
| `isActive` | soft hide (delete is blocked when parts reference it) |

### The three layers

```
Level 0 — ROOTS (10 "systems")                         ← app after-brand + bot drill start
  brake-system, engine-system, suspension-and-steering, transmission,
  heating-and-cooling, maintenance-and-fluids, electrical-and-lighting,
  tuning-and-accessories, motor-oil, cat_uncategorized
    │
    ├── Level 1 — 52 SUBCATEGORIES     (front-brake-pads, oil-filters…)  ← browse leaves
    │
    └── Level 1 — 12 BUCKETS           (brakes, engine, filters…)        ← home grid ONLY
          • carry a non-null `mainCategory` enum
          • hidden from the app drill AND the bot drill
          • ordered by importance via `sortOrder`
          • may have a few legacy level-2 leaves (brakes → brake-pads)
```

Buckets and subcategories are **siblings** under a root. Both drills filter the
buckets out, so users never see the duplication; it exists only in the raw table.

---

## 2. Enum mirrors (classification vocabulary)

`src/catalog/categories/category-map.ts`:

- `PartMainCategory` (12) → **bucket** slug via `MAIN_CATEGORY_TO_SLUG` (`BRAKES → brakes`)
- `PartVehicleCategory` (8) → **root** slug via `VEHICLE_CATEGORY_TO_SLUG` (`ENGINE → engine-system`)
- `MAIN_CATEGORY_BY_SLUG` / `VEHICLE_CATEGORY_BY_SLUG` — reverse maps. A category id
  that is a key of `MAIN_CATEGORY_BY_SLUG` **is** a bucket (used to filter them out).
- `CategoryAnchor` — well-known ids (`OTHER`, `MOTOR_OIL`) whose kinds drive the
  "Другое"/oil questionnaires.

---

## 3. Write path — bot listing → categorized part

```
Seller in Telegram wizard
   │  ├─ drills ROOT → SUBCATEGORY        selectCategory() in product-wizard.ts
   │  │     buckets filtered from options  →  loadCategoryOptions() in telegram.service.ts
   │  │     (a bucket id is a key of MAIN_CATEGORY_BY_SLUG)
   │  └─ keyword classifier (src/ai/part-classifier.ts) → ALWAYS a mainCategory
   ▼
Product { categoryId = chosen leaf, mainCategory = classifier guess, vehicleCategoryId = root }
   ▼   CatalogProjectionService  (src/catalog/projection/catalog-projection.service.ts — the ONE mapping)
CatalogPart.categoryId =
   1. product.categoryId                     // the subcategory the seller picked     ← primary
   2. else MAIN_CATEGORY_TO_SLUG[mainCategory]   // bucket fallback (auto-classified)
   3. else 'cat_uncategorized'               // synthetic fallback (categoryId is NOT NULL)
CatalogPart.mainCategory =                        // powers the bucket rollup
   1. product.mainCategory                   // assigned (classifier, operator) — always wins
   2. else mainCategoryForCategory(categoryId)   // tree rule: the node's own entry, else its
                                             //   nearest ancestor's (category-map.ts)
   3. else null                              // no home bucket: listed or unreviewed node
```

**Key facts**
- Hiding buckets from the seller drill does **not** break `mainCategory`: it always
  falls back to the classifier's guess (`part-classifier.ts` returns a category for
  every part; fallback `ENGINE`). So a part filed on a subcategory still rolls up to
  its bucket on the home grid.
- `product.categoryId` is priority #1, so once the bot captures a subcategory id the
  part lands there with no other change.
- Driver's Village (1C) positions get no classifier guess: the classification import
  sets `mainCategory` only for a bucket row, so their bucket comes from the tree rule
  (`CATEGORY_ID_TO_MAIN_CATEGORY`; nodes with no bucket among the 12 are listed in
  `CATEGORIES_WITHOUT_MAIN_CATEGORY`). An imported part's classification is written on
  create only, so rows that already exist are filled by `npm run backfill:root-buckets`.
- **Operator move** (`PATCH /v1/admin/products/bulk-move`, `DELETE
  /v1/admin/categories/:id?reassignTo=`) writes `CatalogPart.categoryId` together with
  `mainCategory = mainCategoryForCategory(target)` and `vehicleCategory =` the enum of the
  target's root (`vehicleCategoryForCategory`), read from the live tree by id. The old
  bucket is never kept — it belonged to the old filing — so a moved part shows on the
  tile of its new category, or on none when the target has no bucket. Nothing else of
  the part is written. A rating edit re-projects with `keepClassification`, so it cannot
  undo a move; a Telegram seller re-listing the same part still re-files it.

---

## 4. Read paths — buyer app (`matorui`)

| Surface | Endpoint | Backend | What it returns |
|---|---|---|---|
| Home **"Shop by category"** | `GET /v1/reference/categories` | `reference.service.ts` → `part-category.service.ts` | the 10 roots, localized, each with **`productsCount`**: the buyer-listed parts filed on the root or anywhere beneath it through active nodes, each part once (`catalogRootProductCounts`: one GROUP BY `category_id` + one tree read) |
| After brand → **systems** | `GET /v1/reference/categories` | `reference.service.ts` → `part-category.service.ts` | the 10 roots, localized; app strips buckets |
| System → **subcategories** | `GET /v1/reference/categories?parentId=<root>` | same | the 52 subs; app strips buckets |
| Subcategory → **parts** | `GET /v1/catalog/parts?category=<subId>` | catalog parts | parts with that exact `categoryId` |

**App plumbing** (`matorui`):
- `services/reference-catalog.ts` — `fetchReferenceCategories()` maps the tree,
  exposes the localized names, and **filters the 12 bucket ids** (`MAIN_CATEGORY_BUCKET_IDS`)
  out of the drill. The backend's own `localizedCategoryName()`
  (`src/common/app-lang.util.ts`) picks `nameRu`/`nameUz`/`nameEn` by the active
  language, falling back down the chain rather than rendering an empty label.
- `hooks/use-system-categories.ts` — the after-brand systems list (roots), localized,
  hides `cat_uncategorized`.
- Home grid: the roots of `GET /v1/reference/categories` with their `productsCount`
  (`hooks/use-categories.ts`); the systems list ignores the count.

> **Reference cache:** `GET /v1/reference/categories` returns `slug ?? id` and is
> Redis-cached (`PartCategoryService.CACHE_TTL_SECONDS = 300`). It **masks** null/duplicate
> slugs. The admin panel (`admin-categories.presenter.ts`) reads the raw column — trust
> it, not the API, for slug truth. Bust early with `redis-cli DEL cache:reference:categories`.
> The roots' `productsCount` is cached apart (`cache:reference:categories:counts`, 60 s)
> and merged per request, so the roots payload the bot shares never holds a count; every
> admin category write drops both keys.

---

## 5. Localization

Three shipped languages: **ru**, **uz** (Latin script), **en**. The vocabulary
lives in `src/common/app-lang.util.ts` (`AppLang`, `toAppLang`/`toBotLanguage`,
`localizedCategoryName`).

- **Category names** — `name_ru` / `name_uz` / `name_en`, all `NOT NULL`. The
  admin API requires all three on create and refuses to blank any of them on
  update (`CreateCategoryDto` / `UpdateCategoryDto`); the DB `NOT NULL`
  constraints are the backstop. `name` is internal and no longer displayed.
- **Translations for the seeded tree** live in ONE table,
  `src/prisma/seed-data/category-names.seed.ts`, which every seed path writes
  from (`seed.ts`, `seed-categories.ts`, `restore-buyer-buckets.ts`, and the
  projection's fallback bucket), so no two entry points can name a category
  differently.
- **Seller bot** — a seller picks a language from `/start` (first run) or
  `/language`, stored as `sellers.lang` (`BotLanguage?`; `null` = never chose,
  which is what makes the picker fire exactly once). Every bot string lives in
  `src/telegram/i18n/{ru,uz,en}.ts` against the `BotStrings` interface, so a
  missing translation is a compile error. Category BUTTONS are localized at
  render time from the tree — the cached payload carries all three names, and
  the wizard session carries the language.

---

## 6. Classification

- **Main classifier** — `src/ai/part-classifier.ts`: keyword-scored, ALWAYS returns a
  `mainCategory` (12) + `vehicleCategory` (8). Substring match, longer keyword scores higher.
- **Subcategory classifier** — `src/ai/subcategory-classifier.ts`: 52 root-scoped rules
  (ru/en/uz-latin keywords). `classifySubcategory(text, rootHint)` scores within the root
  first, falls back to global, returns `null` when nothing matches (caller leaves the part put).

---

## 7. Invariants

1. `mainCategory` = bucket (coarse, home grid). `categoryId` = precise node (fine, browse).
2. A part has a `mainCategory` unless its category has no home bucket (`CATEGORIES_WITHOUT_MAIN_CATEGORY`, or a node no rule covers yet) — then it is on no tile but still reachable by drill and search; `categoryId` is a subcategory when known, else a bucket, else `cat_uncategorized`.
3. `level` is always derived from the parent — never accepted from a client.
4. `id === slug`; both unique. A bucket id ∈ `MAIN_CATEGORY_BY_SLUG` keys.
5. Buckets are hidden from BOTH drills (app + bot); they surface only on the home grid.
6. `cat_uncategorized` can never be deleted (fallback bucket); it is hidden from the storefront.
   Neither can the 12 buckets, the seller-bot anchors or `maintenance-and-fluids`: the application
   reaches them by id (`LOAD_BEARING_CATEGORY_IDS`), so hard-deleting one breaks projection or the
   bot with no FK to report it. Deactivate them instead. A hard delete physically removes the row,
   and is refused while listings, live drafts or children point at it; a terminal draft does not
   count, since the sweep keeps those rows forever. Structural writes run under one advisory lock.

---

## 8. Operational scripts (`Backend/`, all idempotent)

| Command | Does |
|---|---|
| `npm run seed:categories` | **dry-run** — the 52 subcategories against the tree; `-- --apply` creates what is missing, `-- --apply --overwrite` also resets existing rows |
| `npm run seed:category-titles` | backfill `name_ru`/`name_uz`/`name_en` from the shared translation table (roots, buckets + subs) |
| `npm run fix:category-slugs` | diagnose + repair root slugs to canonical unique values |
| `npm run restore:buyer-buckets` | **dry-run** — the state of the 12 home-grid buckets; `-- --apply` reactivates/recreates them, ordered by importance |
| `npm run reclassify:subcategories` | **dry-run** — re-file existing parts onto subcategories |
| `npm run reclassify:subcategories -- --apply` | persist the reclassification |
| `npm run backfill:root-buckets` | **dry-run** — fill NULL `main_category` from the tree rule; lists every row, per-bucket counts, tile counts before/after, what stays unbucketed |
| `npm run backfill:root-buckets -- --apply` | persist it (NULLs only; re-runs are no-ops) |

After any of these that change the tree: `redis-cli DEL cache:reference:categories`.

Once a database is live the tree belongs to operators, so these scripts no longer write it unless
asked. `seed` refuses `NODE_ENV=production` without `--allow-production`, and skips categories on a
database with real listings unless given `--reconcile-categories`. `seed:categories` and
`restore:buyer-buckets` are dry-runs without `--apply`; `seed:categories -- --apply` creates what is
missing (read the dry-run first: a missing row may be one an operator removed on purpose), and only
`--overwrite` resets existing rows.

---

## 9. Open items

- **Payme MXIK/ИКПУ codes need entering and confirming against Tasnif.** Fiscal fields:
  `mxik`, `packageCodeSingle`, `packageCodeSet`, `packageCodeBox`, `fiscalConfirmedCodes`. What a listing's
  receipt may carry is decided in one place, `resolveFiscalClassification` in
  `common/fiscal.util.ts`, which the Payme receipt and every console flag share:
  - A code must be the category's **own**. There is no inheritance, and a node with active
    children is refused: it is too broad to classify what sits on it. So are
    `transmission` and `heating-and-cooling`, whose seeded codes predate their
    subcategories.
  - A non-empty `mxik` is not enough. An operator must confirm the exact codes as true of
    **every** listing on the node (`PATCH /v1/admin/categories/:id/fiscal-confirmation`,
    manager or super admin). Editing a code ends the confirmation, and changing it back
    needs a new one.
  - The seeded codes in `CATEGORY_FISCAL_DATA` are candidates, none of them confirmed. Four
    name one product of a broad bucket: a starter on `electrical-parts`, a headlight on
    `lighting`, a spark plug on `ignition`, rubber hoses on `belts-and-hoses`. None of those
    nodes has children in the seeded tree (the subcategories for those goods are their
    siblings), and new listings can land on them through `classificationOf`, so a node still
    holding its code is treated like a parent: `NOT_SELLABLE`, and it cannot be confirmed
    (`REPRESENTATIVE_ONLY_MXIK`). A different code entered by an operator lifts that.
  - `OIL_TYPE_FISCAL` supplies the codes of a composition category only while it has no MXIK
    of its own, and needs confirming on each one. An operator's code there wins over the
    table, and a position imported as `SPARE_PART` may sit on it; the table itself is for
    `MOTOR_OIL` only.
  - Until then checkout refuses the listing. `GET /v1/admin/categories?fiscalStatus=NEEDS_CODES`
    and `=NEEDS_CONFIRMATION` list what is left to do.
  - Package codes go to Payme as `package_code`, and Tasnif issues them **per MXIK**: there is
    no universal code for a piece, a set or a box. `PACKAGE_CODE_COLUMN` maps a sale form to
    the category's column, and nothing stands in for a missing code: a set or box with no
    code of its own is refused, not sold as a piece. A listing that states no form takes the
    single code only where the category holds no other, because confirming that one code says
    everything filed there is sold that way. On a category holding more, it is refused until
    an operator states the form (`bulk-move` with `packageForm`, on the part alone).
- **The receipt is frozen on the invoice.** `POST /v1/payments/payme/invoices` runs every rule
  above and stores the resulting `detail` in `payme_fiscal_snapshots`, which a trigger keeps
  immutable. CheckPerformTransaction hands over that copy and CreateTransaction binds the
  transaction to that row; neither reads the catalog's fiscal data, because Check carries no
  transaction id to tie a later build to. So a corrected code applies to invoices issued after
  it: an open invoice keeps what it froze, for as long as the order's payment window lasts. A
  second tap on Pay reuses the open invoice. With none open (a link already used and cancelled,
  or past its window), Check and Create refuse and the customer starts the payment again.
- **Fiscal receipts.** Payme reports what it registered through `SetFiscalData`, stored in
  `payme_fiscal_receipts`, one row per payment and type (`PERFORM`, `CANCEL`). A repeat changes
  nothing. An accepted receipt (`status_code` 0, the only code Payme's documentation gives a
  meaning for) is never overwritten: a differing callback is kept beside it (`last_conflict_*`)
  and answered with success, for reconciliation to look at. Nothing reads these rows yet.
- **Who owns a part's filing.** `bulk-move` writes `CatalogPart` alone, because a `Product` can
  be shared between sellers. A later projection keeps that filing unless the seller, going
  through the wizard again, gives a different category, kind or oil type than the product
  had. These manual scripts do overwrite it, so do not run them on a filed catalog:
  `npm run backfill:catalog`, `npm run reclassify:subcategories -- --apply`.
- **Delivery.** Part of what the customer pays through Payme, so a line of its own, titled
  `Доставка`, whenever the order's stored `deliveryUzs` is above zero.
  - Its codes are a system constant (`DELIVERY_FISCAL_CODES`): MXIK `10112006002000000`, unit
    «услуга (сум)» `1542432`. They belong to no category, so nothing confirms them, and no
    environment variable can change them.
  - Its price is what the order stores, written once at creation. No flat price exists: the
    real one is to come per order from the delivery provider, so until then nothing is
    quoted for a courier, and goods can only be picked up: `POST /v1/orders` with a courier
    is refused however it is to be paid (`DELIVERY_COST_UNAVAILABLE`).
    `Order.deliveryMethod = COURIER` with goods and a cost of 0 means "no cost known", which
    every Payme step refuses. Nothing may change the stored cost once payment has started,
    or fetch a new one between Check and Perform.
  - Delivery is Mator's own line, inside Mator's order and receipt. Mator (ООО «MATOR
    INNOVATIONS») pays turnover tax and is not registered for VAT, so `vat_percent` is a
    system constant of 0 (`DELIVERY_VAT_RATE`). Turnover tax is a different tax and its rate
    never goes there. `DELIVERY_VAT_PERCENT` is no longer read.
  - Its tax id, `commission_info.tin`, is `MARKETPLACE_TIN`, Mator's 9-digit ИНН. Unset, or
    anything that cannot be that, including YandexGo's ИНН, the line is refused and the boot
    log says so. Nothing is ever recorded in YandexGo's name. The service fee's line carries
    the same tax id, under the same rule.
  - Goods are not Mator's: Mator is the platform, and each line carries its own dealer's tax
    id and VAT rate (`CatalogSeller.tin`, `vatPercent`; 12% at Driver's Village, as an
    operator enters it). No rate of Mator's reaches them, and no dealer's reaches delivery.
- **Service fee.** Mator's own income, charged once per order by a flat tariff on the cost of
  the parts (`src/orders/service-fee.util.ts`, the only copy of the tiers; the app shows what
  the API answers): up to and including 100 000 nothing, then 5 000, from 200 000 10 000, from
  500 000 20 000, from 1 000 000 30 000. Worked out from the server's cart on every cart read
  and change, and written once, with the other charges, when the order is created
  (`orders.service_fee_uzs`). Nothing in a request can state it: `confirmed_total_uzs` only
  says what the buyer was shown, and a total that no longer matches is refused with
  `ORDER_TOTAL_CHANGED`. `SERVICE_FEE_UZS` is not read.
  - What it is computed from: catalog parts and sourced offers at their current (sale) price,
    before a promo code. A promo discounts the goods only, never the fee or delivery. A
    service booked beside the goods is not a part and adds nothing. Both are choices made in
    this code, not stated in the tariff: see the release report.
  - On the receipt it is a line of its own, titled `Сервисный сбор`, count 1, never inside a
    goods price or delivery, and absent when the fee is 0. Its codes come from configuration,
    because nobody has supplied them yet: `SERVICE_FEE_MXIK`, `SERVICE_FEE_PACKAGE_CODE` and
    `SERVICE_FEE_VAT_PERCENT`. Delivery's codes are refused there, as is a malformed code, and
    no rate is assumed. Its tax id is `MARKETPLACE_TIN`, like delivery's. With any of the four
    missing, Payme refuses every order that carries a fee, and the boot log says so.
  - Refunds: Payme can only reverse a whole transaction, fee included, and the refund registry
    records that the fee went back. A refund recorded by hand states how much of it is the fee
    (`serviceFeeUzs`, 0 unless stated): a partial refund leaves the fee with Mator, a refund
    reaching into the fee has to say so, and it can never be given back twice. The fee is
    never recomputed for what remains of an order.
- **Whose money an order holds.** The buyer pays Mator the whole total, and Mator settles with
  the sellers. Each order line records the storefront that sold it (`order_items.seller_id`),
  frozen when the order is placed, and `src/orders/order-settlement.ts` sums what each seller
  is owed from their own lines. The fee and delivery are separate columns and Mator's lines on
  the receipt, so they are in no seller's figure, by construction. A promo code is spread into
  the line prices, so a seller's figure is net of it: whether the seller or Mator bears that
  discount is an open business decision. Nothing pays a seller yet, and refunds are not taken
  off a seller's figure, because the registry does not say which seller's goods went back.
- **Services.** A service line takes its codes from `ProviderServiceOffering.categoryId`, under
  the same resolver and confirmation, and its tax data from `ServiceProvider.tin` /
  `vatPercent`. Nothing writes those columns yet, so every service line is refused.
  `PAYME_ALLOW_SERVICE_ONLY_ORDERS=true` lifts only the refusal of an order made up of
  services alone; it is no way around any of this. Keep it off until services are classified.
- Admin panel: the three localized name inputs are specified in
  `docs/frontend/ADMIN_FRONTEND_SPEC.md` §1.3 and served by the API; the console
  UI itself lives in the separate admin-panel repo.
- Buckets and subs coexist under each root in the raw table (invisible to users). A strict
  cleanup would reparent the buckets to a hidden anchor.
