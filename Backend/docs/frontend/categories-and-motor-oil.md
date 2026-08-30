# Frontend Integration Spec — Categories, "Другое", and Motor Oil

Everything below is taken from the current implementation. Endpoint paths, field
names and validation rules were read out of the controllers/DTOs/presenters —
nothing here is aspirational.

**Conventions**

- Admin endpoints return `{ success: true, data: … }` (and `meta` on lists).
- Buyer endpoints return bare objects (`{ items, total, … }`) — no `success`.
- Admin uses **camelCase**, the buyer catalog uses **snake_case**. This is
  pre-existing and deliberate; don't normalize one into the other.

---

## PART 1 — Admin Panel: category management

### 1.1 The tree

One table, `PartCategory`, self-referencing. Current shape:

```text
PartCategory
├── brake-system            (level 0)  ─┐
├── maintenance-and-fluids  (level 0)   │ vehicle roots — shown at the
├── suspension-and-steering (level 0)   │ bot's CATEGORY step
├── electrical-and-lighting (level 0)   │
├── engine-system           (level 0)   │
├── transmission            (level 0)   │
├── heating-and-cooling     (level 0)   │
├── tuning-and-accessories  (level 0)  ─┘
│     └── (level 1 main categories: brakes, filters, engine, …)
│            └── (level 2 subcategories, when an admin adds them)
├── motor-oil               (level 0)   ← offered next to the vehicle roots
└── other                   (level 0)   ← NOT offered there; own button in the bot
    ├── industrial-oil         (level 1)
    ├── motorcycle-oil         (level 1)
    ├── agricultural-machinery (level 1)
    └── other-lubricants       (level 1)
```

`cat_uncategorized` also exists as an internal fallback bucket for unclassified
buyer parts. It is `level: 1` with `parentId: null` specifically so it never
appears among the roots. **Do not offer it as a choice in the admin UI.**

### 1.2 Fields

From `ADMIN_CATEGORY_NODE_SELECT` / `presentAdminCategoryNode`
(`src/admin/categories/admin-categories.presenter.ts`):

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | **The id IS the slug.** Derived server-side on create; never sent by the client. |
| `name` | `string` | Display name. Free-form, renameable. |
| `slug` | `string \| null` | Unique. Nullable only for legacy rows. |
| `parentId` | `string \| null` | `null` = root. |
| `level` | `number` | **Derived, never accepted from the client.** 0 = vehicle/root, 1 = main, 2 = subcategory. |
| `sortOrder` | `number` | Ordering among siblings. Default `0`. |
| `iconKey` | `string \| null` | Icon key for the buyer grid. |
| `color` | `string \| null` | Accent color, hex. |
| `isActive` | `boolean` | Soft-delete/visibility. Inactive is hidden from bot **and** buyer. |
| `mainCategory` | `PartMainCategory \| null` | Legacy enum mirror. Only the 12 canonical buyer rows carry it. Leave `null` for "Другое" children. |
| `productsCount` | `number` | Buyer-catalog parts linked **directly** to this node (not recursive). |
| `listingsCount` | `number` | Supply-side products + drafts pointing here. **This is what blocks a hard delete.** |
| `children` | `AdminCategoryTreeNode[]` | Only on `GET /tree`. |

There is no `description` field on a category.

### 1.3 Admin endpoints

All are under `@Controller('v1/admin/categories')` with
`@UseGuards(AdminJwtGuard, AdminRoleGuard)` and
`@Roles(SUPER_ADMIN, MANAGER, OPERATOR)`.

**Auth (all endpoints):** `Authorization: Bearer <admin access token>`. An
app-user token is rejected. `401` = missing/invalid token, `403` = insufficient
role. Every endpoint below is admin-only; there are no public writes.

| # | Method | URL | Purpose |
|---|---|---|---|
| 1 | `GET` | `/v1/admin/categories` | Flat, filterable list |
| 2 | `GET` | `/v1/admin/categories/tree` | Full nested forest |
| 3 | `GET` | `/v1/admin/categories/:id` | One node |
| 4 | `POST` | `/v1/admin/categories` | Create |
| 5 | `PATCH` | `/v1/admin/categories/:id` | Partial update (incl. re-parent) |
| 6 | `POST` | `/v1/admin/categories/:id/activate` | Activate |
| 7 | `POST` | `/v1/admin/categories/:id/deactivate` | Deactivate |
| 8 | `PATCH` | `/v1/admin/categories/:id/move` | Re-parent + reorder |
| 9 | `DELETE` | `/v1/admin/categories/:id` | Hard delete (guarded) |

#### 1 — `GET /v1/admin/categories`

Query (`ListCategoriesQueryDto`), all optional, AND-combined:

- `parentId` — pass the **literal string `"null"`** for roots only. Omitting it
  applies no parent filter at all. (These are different!)
- `level` — integer ≥ 0.
- `isActive` — `true` / `false` (string or boolean both accepted).

Ordered by `level`, then `sortOrder`, then `name`.

```
GET /v1/admin/categories?parentId=other&isActive=true
→ 200 { "success": true, "data": [ …nodes… ], "meta": { "total": 4 } }
```

`400` on an unknown query param — the global `ValidationPipe` runs with
`forbidNonWhitelisted`, so don't send extras.

#### 2 — `GET /v1/admin/categories/tree`

No query params. Returns the whole forest nested via `children`. Use this to
render the tree view in one request.

#### 3 — `GET /v1/admin/categories/:id`

`404` if missing. Returns a flat node (no `children`).

#### 4 — `POST /v1/admin/categories`

Body (`CreateCategoryDto`) — **this class is the whitelist**; unknown fields 400:

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | 1–160 chars |
| `slug` | ❌ | ≤96 chars. Derived from `name` when omitted. Becomes the `id`. |
| `parentId` | ❌ | `null`/omitted = root |
| `iconKey` | ❌ | ≤48 |
| `color` | ❌ | ≤16 |
| `sortOrder` | ❌ | integer ≥ 0, default 0 |
| `mainCategory` | ❌ | `PartMainCategory` enum — omit for "Другое" children |

**There is no `level` field.** It is computed as `parent.level + 1`. Sending one
is a 400 (not whitelisted).

Errors: `400` unslugifiable name / invalid body · `404` parent not found ·
`409` slug already in use.

#### 5 — `PATCH /v1/admin/categories/:id`

Body (`UpdateCategoryDto`), every field optional; only what you send is written:
`name`, `slug`, `iconKey`, `color`, `parentId` (`null` promotes to root),
`sortOrder`, `isActive`, `mainCategory`.

A `parentId` change goes through the same cycle guard as `/move` and re-derives
`level` for the node **and its whole subtree**.

Errors: `400` invalid body / would create a cycle · `404` no such category or
target parent · `409` slug in use.

#### 6 / 7 — activate / deactivate

`POST /v1/admin/categories/:id/activate` · `POST …/deactivate`. No body.
Returns the updated node. `404` if missing.

**Prefer deactivate over delete.** Deactivating a parent hides its entire
subtree from the bot and the buyer, because every read filters `isActive` at
each level. It is fully reversible.

#### 8 — `PATCH /v1/admin/categories/:id/move`

Body (`MoveCategoryDto`): `parentId` (required, `null` = promote to root),
`sortOrder` (optional).

Rejects with `400` if the new parent is the category itself or one of its own
descendants (cycle guard), or if the move would exceed the depth cap.

#### 9 — `DELETE /v1/admin/categories/:id`

Optional `?reassignTo=<categoryId>` to move referencing **buyer parts** first.

Refuses with `409` when:
- supply-side products/drafts reference it (`listingsCount > 0`) — deactivate instead;
- it still has child categories;
- it is `cat_uncategorized`;
- buyer parts reference it and no `reassignTo` was given.

### 1.4 Reordering

There is **no dedicated reorder endpoint and no bulk-reorder**. Set `sortOrder`
per node via `PATCH /:id` or `PATCH /:id/move`. For drag-and-drop, issue one
`PATCH` per moved sibling. Ties break by `name`.

### 1.5 Creating a category under OTHER

The exact flow for *Admin Panel → Categories → OTHER → Add subcategory →
"Motorcycle Oil"*:

1. Get the OTHER root's id from the API (see Part 7 — do **not** hardcode it).
2. `POST /v1/admin/categories` with `{ "name": "Motorcycle Oil", "parentId": "<other id>" }`.

That's it. The backend derives `slug`/`id` → `motorcycle-oil` and `level` → 1.

**The frontend does not need to know this category leads to a `MOTOR_OIL`
questionnaire.** That mapping is backend business logic (`CATEGORY_ID_TO_KIND`,
keyed on the anchor id `motor-oil`). To the admin UI, an OTHER child is pure
taxonomy: name, slug, order, active. Do not add a "product kind" picker.

### 1.6 What happens on edit / move / activate — and caching

| Admin action | Effect |
|---|---|
| Rename | Display name changes everywhere. **Safe** — nothing keys on names. |
| Change slug | Changes `slug`, **not** the `id` of an existing row. Existing listings keep pointing at the same `id`. |
| Move to another parent | Re-parents, re-derives `level` for the node and its whole subtree. Cycle-guarded. |
| Reorder | `sortOrder` changes button/grid order. |
| Deactivate | Disappears from bot and buyer immediately on next read. Existing listings keep their `categoryId`. |
| Reactivate | Reappears. |

**Caching — what the frontend must know:** category reads are cached server-side
(Redis, 300 s TTL), but **every admin write explicitly invalidates** the affected
keys. You do not need to bust anything, pass cache-busting params, or delay the
UI. After a successful `2xx`, a re-fetch returns fresh data.

Do **not** implement your own category cache with a longer lifetime — you would
reintroduce the staleness the backend just eliminated.

---

## PART 2 — What "Другое" means

You are not building the bot, but the resulting data model matters.

### Path A — vehicle-specific motor oil

```text
Brand (Chevrolet) → Model (Cobalt) → Category → "Моторные масла"
```

Result:

```text
kind              = MOTOR_OIL
isUniversal       = false          ← vehicle was named
brand/model       = Chevrolet / Cobalt   (persisted as fit rows)
vehicleCategoryId = motor-oil
categoryId        = motor-oil
```

### Path B — "Другое" motor oil

```text
Brand → "Другое" → "Что продаёте?" → Моторное масло
      → <an OTHER child, e.g. Motorcycle Oil>
```

Result:

```text
kind              = MOTOR_OIL
isUniversal       = true           ← no vehicle was ever asked
brand/model       = null / null    (no fit rows)
vehicleCategoryId = other
categoryId        = motorcycle-oil
```

### Path C — "Другое" antifreeze

```text
Brand → "Другое" → "Что продаёте?" → Антифриз → вес (кг)
```

Result:

```text
kind              = ANTIFREEZE
isUniversal       = true           ← no vehicle is ever asked
brand/model       = null / null    (no fit rows)
vehicleCategoryId = maintenance-and-fluids
categoryId        = antifreeze     ← the EXISTING buyer-tree leaf
antifreezeWeightG = 2500           ← "2.5 кг", stored in grams
```

Antifreeze is quantified **by weight**, never by the piece: the seller picks or
types a package weight in kilograms and it is stored as an integer number of
grams. See `unit` in Part 4.

**`OTHER` is not a `ProductKind`.** `ProductKind` has three values —
`SPARE_PART`, `MOTOR_OIL` and `ANTIFREEZE`. `other` is a `PartCategory` row — a
taxonomy root. Paths A and B both produce `kind = MOTOR_OIL`; they differ only
in category and universality.

**The "Что продаёте?" step is a KIND question, not a category one.** It is a
closed, code-level list (one entry per non-vehicle `ProductKind`), so it is NOT
admin-editable and does NOT appear in the category tree. The admin-managed
OTHER children are still pure taxonomy, reached *after* "Моторное масло".

---

## PART 3 — Getting oils under OTHER

### 3.1 List the OTHER children (public)

```
GET /v1/reference/categories?parentId=<other id>
→ 200 {
    "items": [
      { "id": "motorcycle-oil", "name": "Мотоциклетные масла",
        "slug": "motorcycle-oil", "parentId": "other", "level": 1, "sortOrder": 1 }
    ],
    "total": 1
  }
```

Public, no auth. **Only active categories are ever returned**, at any level.
`404` if `parentId` is unknown; an empty `items` is a normal `200` meaning "this
category is a leaf". `GET /v1/reference/categories/:id/children` is an identical
path-param form.

> ⚠️ **Do not use `GET /v1/categories` for this.** That endpoint serves only the
> 12 main buyer-grid categories (it filters on `mainCategory != null`) and will
> not return OTHER children.

### 3.2 List the products in one of them

```
GET /v1/catalog/parts?category=motorcycle-oil&page=1&page_size=20
```

The `category` param is **three-way** (`parts.service.ts` `buildWhere`):

1. value is a `PartMainCategory` enum (`BRAKES`) → filters `mainCategory`;
2. value is a `PartVehicleCategory` enum (`BRAKE_SYSTEM`) → filters `vehicleCategory`;
3. **anything else → filters `categoryId`** ← this is the path OTHER children take.

No value 404s. So `?category=motorcycle-oil` works today with no new endpoint.

**`main_category` is not a query param.** It is a *response* field. Use
`category=` for both legacy enums and new ids — that is what keeps old and new
clients working against one filter.

### 3.3 Other filters, pagination, sorting, search

- `kind=motor_oil | spare_part | antifreeze` (repeatable, lowercase). Omitted → every kind.
- `viscosity=5W-30` (repeatable, exact, case-insensitive), `oil_type=synthetic|semi_synthetic|mineral`, `volume_ml=4000` (repeatable, **millilitres**) or `volume_ml_min` / `volume_ml_max`. Any of these implies `kind=motor_oil`.
- `q=` free-text over title.
- `make=` / `model=` — canonical name (`Chevrolet`) or slug (`make_chevrolet`).
- `brand=`, `region=` (repeatable), `gm_only`, `oem_only`, `in_stock_only` (`"true"`/`"false"` strings).
- `vehicle_id=` — restricts to parts compatible with a garage vehicle.
- `sort=price_asc | price_desc | relevance`.
- `page` (≥1), `page_size` (1–100).

**Unknown query params are rejected with `400`.** Send only what's listed.

Envelope:

```jsonc
{
  "items": [ /* part items, see Part 4 */ ],
  "facets": {
    "brands": [...],
    "price_range_uzs": { "min": 0, "max": 0 },
    "compatibility": null,          // non-null only when vehicle_id was passed
    "motor_oil": { /* viscosity/type/volume chips + counts, null for non-oil queries */ }
  },
  "page": 1,
  "page_size": 20,
  "total": 42,
  "next_page": 2                     // null on the last page
}
```

### Already available vs. Backend change required

**Already available** — everything in 3.1–3.3 works against the shipped API.

**Backend change required — and already applied in this pass.** The audit found
a real gap: `CatalogProjectionService` derived the buyer-side `categoryId`
*only* from the legacy `mainCategory` enum. An OTHER-child oil has
`mainCategory = null`, so every such listing projected into `cat_uncategorized`
and `?category=motorcycle-oil` would have returned **nothing**. Fixed by having
the projection prefer the seller's chosen `Product.categoryId`, falling back to
the enum mapping and then the bucket. One file
(`src/catalog/projection/catalog-projection.service.ts`), two regression tests.
No endpoint, DTO or response shape changed.

---

## PART 4 — Product fields

`GET /v1/catalog/parts/:id?vehicle_id=<optional>` and each `items[]` entry share
the same shape (`presentPartItem`).

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | |
| `title` | `string` | |
| `kind` | `"SPARE_PART" \| "MOTOR_OIL" \| "ANTIFREEZE"` | Drives which card to render |
| `unit` | `"PCS" \| "L" \| "KG"` | **The unit this listing is quantified in.** Render quantities with this — never a hardcoded "шт". `PCS` for spare parts, `L` for oils, `KG` for antifreeze |
| `motor_oil` | object \| `null` | `null` unless `kind === "MOTOR_OIL"` |
| `motor_oil.viscosity` | `string \| null` | e.g. `"5W-30"` |
| `motor_oil.oil_type` | `"SYNTHETIC" \| "SEMI_SYNTHETIC" \| "MINERAL" \| null` | raw enum |
| `motor_oil.oil_type_label` | `string \| null` | pre-localized, e.g. `"Синтетическое"` |
| `motor_oil.volume_ml` | `number \| null` | millilitres |
| `motor_oil.volume_label` | `string \| null` | e.g. `"4 л"` |
| `antifreeze` | object \| `null` | `null` unless `kind === "ANTIFREEZE"` |
| `antifreeze.weight_g` | `number \| null` | net weight in **grams** (exact; sortable) |
| `antifreeze.weight_label` | `string \| null` | e.g. `"2.5 кг"` — render this |
| `category` | `{ id, name }` | The `PartCategory` this part points at |
| `main_category` | enum \| `null` | Legacy mirror; `null` for admin-created categories |
| `vehicle_category` | enum \| `null` | Legacy mirror |
| `is_universal` | `boolean` | **The field for universal vs vehicle-specific** |
| `compatibility` | object \| `null` | `null` for universal listings |
| `fits` | array | `{make_slug, make_name, model_slug, model_name}`; **empty for universal** |
| `brand` | `{ id, name } \| null` | Part manufacturer |
| `part_brand_name` | `string \| null` | |
| `part_number_type` | `"GM" \| "OEM" \| "UNKNOWN" \| null` | **`null` for oils and antifreeze** — never render an OEM/GM row |
| `oem_numbers` / `gm_numbers` | `string[]` | Empty for oils |
| `is_oem` / `is_gm` | `boolean` | |
| `origin_region` | enum \| `null` | |
| `price_uzs` | `number` | Plus `price_label`, and `original_price_uzs` + `sale` when a campaign applies |
| `currency` | `string` | `"UZS"` |
| `in_stock` | `boolean` | |
| `delivery_eta_days_min/max` | `number \| null` | |
| `images` | `string[]` | |
| `seller` | `{ id, name, rating_avg, certified, lowest_price }` | |

> ⚠️ **Exactly one kind block is ever non-null.** `motor_oil` and `antifreeze`
> are siblings; switch on `kind` and read the matching one. A kind added later
> adds a sibling key rather than changing either of these.

> ⚠️ **`antifreeze.weight_g` is the PACKAGE size, not an order quantity.** Cart
> and order quantities stay integer counts of listings ("2 канистры"); the
> weight describes what one listing contains.

> ⚠️ **There is no `description` field** on the buyer part response. Don't design
> a layout that requires one. (The seller does enter a description in the bot; it
> is stored on the supply-side `Product` but is not currently projected to the
> buyer card. If the design needs it, that's a separate backend request.)

---

## PART 5 — Universal vs vehicle-specific

**Use `is_universal`. Never infer from the category name.**

### Universal (listed under "Другое")

```jsonc
{ "kind": "MOTOR_OIL", "category": { "id": "motorcycle-oil", "name": "Мотоциклетные масла" },
  "is_universal": true, "compatibility": null, "fits": [] }
```

Render: "Подходит для всех" / no vehicle chip. **Do not** show a compatibility
badge — `compatibility` is deliberately `null`, because answering "maybe" for a
product that fits everything is actively misleading.

### Vehicle-specific (chosen after a car)

```jsonc
{ "kind": "MOTOR_OIL", "category": { "id": "motor-oil", "name": "Моторные масла" },
  "is_universal": false,
  "compatibility": { "status": "…" },
  "fits": [ { "make_name": "Chevrolet", "model_name": "Cobalt", … } ] }
```

Render the vehicle chips from `fits[]`, and the compatibility badge from
`compatibility` when a garage vehicle is selected.

**Both are `kind: "MOTOR_OIL"` and both may live under different categories.**
The rule is exactly: `compatibility !== null` ⟺ `is_universal === false`.

---

## PART 6 — Admin → Telegram → Buyer

```text
Admin creates/edits a category   (POST/PATCH /v1/admin/categories…)
        ↓  cache invalidated automatically by the write
PartCategory row in PostgreSQL
        ↓  GET /v1/reference/categories?parentId=… (active only)
Telegram bot renders buttons carrying the category ID
        ↓  seller taps → id re-validated against the live tree
ProductDraft.categoryId / .vehicleCategoryId
        ↓  commit (lineage re-validated server-side)
Product.categoryId / .vehicleCategoryId
        ↓  projection (prefers Product.categoryId)
CatalogPart.categoryId
        ↓  GET /v1/catalog/parts?category=<id>
Frontend listing
```

While sellers are mid-flow:

| Admin does | Seller experience |
|---|---|
| **Creates** a category | Appears on the next render. No redeploy. |
| **Renames** it | New name on next render. In-flight buttons still work — they carry the **id**, not the name. |
| **Deactivates** it | Disappears from new renders. A tap on an already-sent button is **rejected** with "эта категория больше недоступна" and the step re-renders from the current tree. |
| **Moves / re-parents** it | Same rejection: the tap is re-checked against the live tree and its parent must still match where the seller stands. |

**Stale-callback behavior** matters to you only in one respect: a listing's
`categoryId` always points at a category that was valid **at commit time**. If an
admin later deactivates that category, existing products keep pointing at it —
they are not retroactively re-categorized. So a product's `category.id` may
reference an inactive category. Handle that gracefully (render the name you get;
don't assume it still appears in your active-category list).

---

## PART 7 — No hardcoded category IDs

**Do not hardcode** `motor-oil`, `other`, `industrial-oil`, `motorcycle-oil`, or
any other category id in frontend source.

Ids are stable in practice (they're slug-shaped and the migration/seed pin them),
but they are **admin-editable data**, not an API contract. There is currently
**no public endpoint that advertises "which category is the OTHER root"** — the
anchors live in backend code (`CategoryAnchor` in
`src/catalog/categories/category-map.ts`) and are deliberately not exposed.

So:

- **Admin panel** — you never need an anchor. Render the tree from
  `GET /v1/admin/categories/tree` and let the operator click into "Другое" like
  any other node. Pass the `id` you received when creating a child.
- **Buyer app** — get ids from `GET /v1/reference/categories`, carry them through
  as opaque strings, and pass them straight to `?category=<id>`.
- **Never** match on `name` (renameable, localized) — and don't build behavior on
  `slug` either; prefer the `id` you were handed.

If the buyer app genuinely needs to *find* the OTHER subtree without a user
click, that is a **new backend requirement** (e.g. a documented capability flag
on the reference response). It does not exist today — raise it rather than
hardcoding.

---

## PART 8 — Concrete examples

### 8.1 Admin — create an OTHER child

```http
POST /v1/admin/categories
Authorization: Bearer <admin token>
Content-Type: application/json

{ "name": "Motorcycle Oil", "parentId": "other", "sortOrder": 1 }
```

```jsonc
// 201
{ "success": true,
  "data": { "id": "motorcycle-oil", "name": "Motorcycle Oil", "slug": "motorcycle-oil",
            "parentId": "other", "level": 1, "sortOrder": 1, "iconKey": null,
            "color": null, "isActive": true, "mainCategory": null,
            "productsCount": 0, "listingsCount": 0 } }
```

### 8.2 Admin — the tree

```http
GET /v1/admin/categories/tree
Authorization: Bearer <admin token>
```

```jsonc
// 200
{ "success": true,
  "data": [
    { "id": "other", "name": "Другое", "slug": "other", "parentId": null,
      "level": 0, "sortOrder": 99, "isActive": true, "mainCategory": null,
      "productsCount": 0, "listingsCount": 0,
      "children": [
        { "id": "motorcycle-oil", "name": "Motorcycle Oil", "parentId": "other",
          "level": 1, "sortOrder": 1, "isActive": true, "children": [] }
      ] }
  ] }
```

### 8.3 Admin — deactivate

```http
POST /v1/admin/categories/motorcycle-oil/deactivate
Authorization: Bearer <admin token>
```
→ `200 { "success": true, "data": { …node, "isActive": false } }`

### 8.4 Buyer — list OTHER children

```http
GET /v1/reference/categories?parentId=other
```
```jsonc
// 200
{ "items": [
    { "id": "industrial-oil", "name": "Индустриальные масла", "slug": "industrial-oil",
      "parentId": "other", "level": 1, "sortOrder": 0 },
    { "id": "motorcycle-oil", "name": "Мотоциклетные масла", "slug": "motorcycle-oil",
      "parentId": "other", "level": 1, "sortOrder": 1 }
  ],
  "total": 2 }
```

### 8.5 Buyer — products in Motorcycle Oil

```http
GET /v1/catalog/parts?category=motorcycle-oil&kind=motor_oil&sort=price_asc&page=1&page_size=20
```
```jsonc
// 200
{ "items": [
    { "id": "part_stock_512", "title": "Motul 7100 10W-40 4L", "kind": "MOTOR_OIL",
      "motor_oil": { "viscosity": "10W-40", "oil_type": "SYNTHETIC",
                     "oil_type_label": "Синтетическое",
                     "volume_ml": 4000, "volume_label": "4 л" },
      "category": { "id": "motorcycle-oil", "name": "Мотоциклетные масла" },
      "main_category": null, "vehicle_category": null,
      "is_universal": true, "compatibility": null, "fits": [],
      "part_number_type": null, "oem_numbers": [], "gm_numbers": [],
      "price_uzs": 180000, "currency": "UZS", "in_stock": true,
      "images": ["https://cdn/…"],
      "seller": { "id": "seller_7", "name": "AutoPro", "rating_avg": 4.5,
                  "certified": true, "lowest_price": false } }
  ],
  "facets": { "brands": [], "price_range_uzs": { "min": 180000, "max": 180000 },
              "compatibility": null, "motor_oil": { /* chips */ } },
  "page": 1, "page_size": 20, "total": 1, "next_page": null }
```

### 8.6 Buyer — one product

```http
GET /v1/catalog/parts/part_stock_512?vehicle_id=veh_1
```
Same item shape. With `vehicle_id` supplied, a **vehicle-specific** listing
returns a populated `compatibility`; a **universal** one still returns `null`.

---

## PART 9 — Checklist

**Admin**

- [ ] Render the tree from `GET /v1/admin/categories/tree`
- [ ] Create a child: `POST /v1/admin/categories` with `{name, parentId}` — never send `level` or `id`
- [ ] Edit: `PATCH /v1/admin/categories/:id` (partial)
- [ ] Move: `PATCH /v1/admin/categories/:id/move` — handle `400` cycle errors
- [ ] Activate / deactivate: `POST /:id/activate` · `/deactivate` — prefer over delete
- [ ] Ordering: `sortOrder` per node; one `PATCH` per moved sibling (no bulk endpoint)
- [ ] Errors: `400` validation/cycle · `401` no token · `403` role · `404` missing · `409` slug in use / delete blocked
- [ ] Do not add a "product kind" control — OTHER children are taxonomy only
- [ ] Do not cache categories beyond the request; server invalidates on write

**Buyer**

- [ ] OTHER children via `GET /v1/reference/categories?parentId=<id>` (**not** `/v1/categories`)
- [ ] Products via `GET /v1/catalog/parts?category=<id>`
- [ ] Universal vs vehicle-specific strictly from `is_universal`
- [ ] Oil attributes from `motor_oil.*` (prefer `*_label` for display)
- [ ] Vehicle compatibility from `fits[]` + `compatibility`; both empty/null when universal
- [ ] Never render an OEM/GM row when `part_number_type === null`
- [ ] Pagination `page`/`page_size` + `next_page`; search `q`; sort `sort=`
- [ ] Send no unknown query params (`400`)
- [ ] Category ids are opaque — never hardcoded, never matched by name

---

## Frontend API Contract (condensed)

```http
# ── Admin (Bearer admin token; SUPER_ADMIN | MANAGER | OPERATOR) ──
GET    /v1/admin/categories?parentId=&level=&isActive=
GET    /v1/admin/categories/tree
GET    /v1/admin/categories/:id
POST   /v1/admin/categories                 { name, slug?, parentId?, iconKey?, color?, sortOrder?, mainCategory? }
PATCH  /v1/admin/categories/:id             { name?, slug?, parentId?, iconKey?, color?, sortOrder?, isActive?, mainCategory? }
POST   /v1/admin/categories/:id/activate
POST   /v1/admin/categories/:id/deactivate
PATCH  /v1/admin/categories/:id/move        { parentId, sortOrder? }
DELETE /v1/admin/categories/:id?reassignTo=

# ── Buyer (public) ──
GET /v1/reference/categories?parentId=<id>          # active only; roots when omitted
GET /v1/reference/categories/:id/children
GET /v1/catalog/parts?category=<id>&kind=motor_oil&viscosity=&oil_type=&volume_ml=
                      &q=&make=&model=&vehicle_id=&sort=&page=&page_size=
GET /v1/catalog/parts/:id?vehicle_id=
```

**Admin node:** `id, name, slug, parentId, level, sortOrder, iconKey, color,
isActive, mainCategory, productsCount, listingsCount, children[]`
Envelope: `{ success, data, meta? }`

**Reference node:** `id, name, slug, parentId, level, sortOrder`
Envelope: `{ items, total }`

**Buyer part:** `id, title, kind, motor_oil{viscosity,oil_type,oil_type_label,
volume_ml,volume_label}, category{id,name}, main_category, vehicle_category,
is_universal, compatibility, fits[], brand, part_brand_name, part_number_type,
oem_numbers, gm_numbers, is_oem, is_gm, origin_region, price_uzs, price_label,
currency, in_stock, delivery_eta_days_min/max, images[], seller{…}`
Envelope: `{ items, facets, page, page_size, total, next_page }`

**No `description` on the buyer part. No `level` accepted on admin writes.**
