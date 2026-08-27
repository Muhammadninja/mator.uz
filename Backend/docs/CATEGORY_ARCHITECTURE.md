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
CatalogPart.mainCategory = product.mainCategory   // always kept — powers the bucket rollup
```

**Key facts**
- Hiding buckets from the seller drill does **not** break `mainCategory`: it always
  falls back to the classifier's guess (`part-classifier.ts` returns a category for
  every part; fallback `ENGINE`). So a part filed on a subcategory still rolls up to
  its bucket on the home grid.
- `product.categoryId` is priority #1, so once the bot captures a subcategory id the
  part lands there with no other change.

---

## 4. Read paths — buyer app (`matorui`)

| Surface | Endpoint | Backend | What it returns |
|---|---|---|---|
| Home **"Shop by category"** | `GET /v1/categories` | `categories.service.ts` | the 12 buckets (`isActive AND mainCategory ≠ null`), `sortOrder`; **count grouped by `mainCategory`** so sub-filed parts roll up |
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
- Home grid stays on `GET /v1/categories` (`hooks/use-categories.ts`) — the buckets.

> **Reference cache:** `GET /v1/reference/categories` returns `slug ?? id` and is
> Redis-cached (`PartCategoryService.CACHE_TTL_SECONDS = 300`). It **masks** null/duplicate
> slugs. The admin panel (`admin-categories.presenter.ts`) reads the raw column — trust
> it, not the API, for slug truth. Bust early with `redis-cli DEL cache:reference:categories`.

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
2. Every part has a `mainCategory`; `categoryId` is a subcategory when known, else a bucket, else `cat_uncategorized`.
3. `level` is always derived from the parent — never accepted from a client.
4. `id === slug`; both unique. A bucket id ∈ `MAIN_CATEGORY_BY_SLUG` keys.
5. Buckets are hidden from BOTH drills (app + bot); they surface only on the home grid.
6. `cat_uncategorized` can never be deleted (fallback bucket); it is hidden from the storefront.

---

## 8. Operational scripts (`Backend/`, all idempotent)

| Command | Does |
|---|---|
| `npm run seed:categories` | create the 52 subcategories under the roots |
| `npm run seed:category-titles` | backfill `name_ru`/`name_uz`/`name_en` from the shared translation table (roots, buckets + subs) |
| `npm run fix:category-slugs` | diagnose + repair root slugs to canonical unique values |
| `npm run restore:buyer-buckets` | reactivate/recreate the 12 home-grid buckets, ordered by importance |
| `npm run reclassify:subcategories` | **dry-run** — re-file existing parts onto subcategories |
| `npm run reclassify:subcategories -- --apply` | persist the reclassification |

After any of these that change the tree: `redis-cli DEL cache:reference:categories`.

---

## 9. Open items

- **Payme MXIK/ИКПУ codes** on 8 of 10 roots (only Transmissions, Heating & Cooling,
  Моторные масла configured). Official TASNIF codes — operator-supplied. Fiscal fields:
  `mxik`, `packageCodeSingle`, `packageCodeSet` (a category is fiscally configured when
  `mxik && packageCodeSingle`, see `common/fiscal.util.ts`).
- Admin panel: the three localized name inputs are specified in
  `docs/frontend/ADMIN_FRONTEND_SPEC.md` §1.3 and served by the API; the console
  UI itself lives in the separate admin-panel repo.
- Buckets and subs coexist under each root in the raw table (invisible to users). A strict
  cleanup would reparent the buckets to a hidden anchor.
