# Admin Panel — Categories & Dealers — Frontend Integration Spec

**Audience:** the Admin Panel frontend team.
**Status:** backend implemented and merged. Everything below is read out of the
current controllers/services/DTOs/presenters — nothing here is aspirational.

This spec **supersedes** the category-management section of
[`categories-and-motor-oil.md`](./categories-and-motor-oil.md) (Part 1), which
predates the fiscal fields added to `PartCategory`. That file is still correct
for Parts 2–9 (taxonomy semantics, the buyer-side "Другое" flow, universal vs.
vehicle-specific). Section 1 below is the current source of truth for the admin
category console specifically.

**Conventions used throughout:**

- All admin endpoints require an **admin-panel** bearer token — a mobile-app
  user token is rejected outright. `401` = missing/invalid/expired token,
  `403` = valid token but insufficient role.
- Roles accepted on every endpoint in this document: `SUPER_ADMIN`, `MANAGER`,
  `OPERATOR`. There is no endpoint here that requires a higher role than
  another — the three roles are equivalent for categories and dealers.
- Admin endpoints return `{ success: true, data: … }`, with `meta` added on
  list endpoints.
- Money is a **plain integer number of UZS** on the wire (never a string,
  never in tiyin) unless stated otherwise.
- Error body shape, every non-2xx response:

  ```json
  { "code": "VALIDATION_FAILED", "message": "…", "requestId": "3AA7FC" }
  ```

  `code` is one of `VALIDATION_FAILED` (400), `UNAUTHORIZED` (401),
  `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409). **Only the first
  validation problem is returned** — fix it, resubmit, and you may see the
  next one. Do not build UI that expects an array of field errors, and do not
  try to map `message` onto a specific form field by parsing its text (its
  wording isn't a stable per-field contract). Show it as a **toast/banner**
  with the raw `message`, plus a small "Request ID: `<requestId>`" line for
  support/logs — that is the one error-display pattern that works uniformly
  across every endpoint in this document, since the shape is identical
  everywhere.
- Every DTO below **is the whitelist**. The global `ValidationPipe` runs with
  `whitelist: true, forbidNonWhitelisted: true` — sending a field not listed
  in a request table is a `400`, not a silently-ignored extra.

---

## PART 1 — Category management (`/v1/admin/categories`, `/v1/admin/products`)

### 1.1 What's new since the last spec

`PartCategory` now carries **fiscal configuration** — the MXIK/package codes a
category's products are sold under for Payme receipts. This is admin-owned
data with no other source (nothing auto-fills it), and the console is where it
gets entered.

Also new: the delete-guard count is now split into buyer-catalog parts
(`productsCount`) vs. supply-side products **and drafts**
(`listingsCount` — previously products only), and there's a dedicated
bulk-reassign endpoint for buyer-catalog parts.

**NEW — a category now has THREE REQUIRED display names, one per language.**
`nameRu`, `nameUz` and `nameEn` replace the single display `name`, and all
three are `NOT NULL` in the database. The console's create/edit form therefore
needs **three text inputs**, and must block submission until every one of them
is filled — see [1.3](#13-the-three-localized-names) for the exact contract and
the form rules. The old `name` field still exists but is **internal** (logging,
ordering, slug derivation); it is no longer what any user sees, and the console
does not need to send it.

### 1.2 Fields

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | **The id IS the slug.** Derived server-side on create; never sent by the client. |
| `nameRu` | `string` | **Display name in Russian. Always present.** Render this for a `ru` operator. |
| `nameUz` | `string` | **Display name in Uzbek (Latin).** Always present. |
| `nameEn` | `string` | **Display name in English.** Always present. Also what the slug is derived from on create. |
| `name` | `string` | **Internal** canonical label — logging/ordering/legacy consumers. Do **not** show it to a user and do not offer it as an editable "name" field. |
| `slug` | `string \| null` | Unique. Nullable only for legacy rows. |
| `parentId` | `string \| null` | `null` = root. |
| `level` | `number` | **Derived, never accepted from the client.** 0 = vehicle/root, 1 = main, 2 = subcategory. |
| `sortOrder` | `number` | Ordering among siblings. Default `0`. |
| `iconKey` | `string \| null` | Icon key for the buyer grid. |
| `color` | `string \| null` | Accent color, hex. |
| `isActive` | `boolean` | Soft-delete/visibility. Inactive is hidden from bot **and** buyer. |
| `mainCategory` | `PartMainCategory \| null` | Legacy enum mirror. Only the 12 canonical buyer rows carry it. Leave `null` for "Другое" children. |
| `mxik` | `string \| null` | MXIK / ИКПУ, exactly 17 digits. `null` = not configured. |
| `packageCodeSingle` | `string \| null` | Tasnif package code for "Штука" (a single item). |
| `packageCodeSet` | `string \| null` | Tasnif package code for "Комплект / набор" (a set). Optional even on a configured category — see [1.7](#17-the-fiscal-fields). |
| `fiscalConfigured` | `boolean` | **Derived.** Whether products in this category can be fiscalized (and therefore sold through Payme) at all. |
| `fiscalByOilType` | `boolean` | **Derived.** `true` when this category's products are fiscalized from their own `oilType`, not from the category's codes — see [1.7](#17-the-fiscal-fields). |

### 1.3 The three localized names

Every category is shown to Russian-, Uzbek- and English-speaking users: the
buyer app in its active locale, the Telegram seller bot in the language the
seller picked from its language menu, and this console. A category missing one
of the three would render as a **blank button** for every user of that
language, so the three names are required at every level of the stack:

| Layer | What enforces it |
|---|---|
| Database | `name_ru`, `name_uz`, `name_en` are `NOT NULL` |
| API (create) | `nameRu`, `nameUz`, `nameEn` are all required, and rejected when blank |
| API (update) | Each is optional (patch one language at a time) but **cannot be set to `""`, `"   "` or `null`** |
| Console | The form below must not submit until all three are filled |

**Server-side rules — what produces a `400`:**

- a missing name on `POST` (any of the three);
- an empty string or a whitespace-only string, on `POST` **or** `PATCH` —
  values are trimmed before validation, so `"   "` is treated as empty;
- `null` on `PATCH` (there is no "clear a name" operation — unlike the fiscal
  fields, which do accept `null`);
- anything over 160 characters, or a non-string.

Surrounding whitespace on an otherwise valid name is **trimmed and accepted**,
so the console does not need to trim before sending.

#### Form requirements (create + edit)

Three separate text inputs, in this order:

| Label to show | Field to send | Placeholder example |
|---|---|---|
| Название (RU) | `nameRu` | Турбокомпрессоры |
| Nomi (UZ) | `nameUz` | Turbokompressorlar |
| Name (EN) | `nameEn` | Turbochargers |

- **All three are mandatory.** Mark each with the required indicator.
- **Disable the submit button** while any of the three is empty or
  whitespace-only, and highlight the offending input(s) inline (`red border` +
  a message such as "Заполните название на этом языке"). This is a *client-side*
  gate — do not rely on the server round-trip to discover it.
- Validate on blur and on submit, not on every keystroke, so a half-typed name
  is not flagged as an error.
- Uzbek is written in **Latin script** (`Turbokompressorlar`, not
  `Турбокомпрессорлар`) — it is the script both apps ship their `uz` locale in.
- On **edit**, prefill each input from `nameRu` / `nameUz` / `nameEn` on the
  node. Clearing an input and saving is a `400`, so treat it exactly like the
  create case and block it in the form.
- Do **not** render an input for `name`. It is internal; the API fills it from
  `nameEn` when omitted.
- The English name additionally seeds the slug (and therefore the `id`) on
  create when no explicit `slug` is sent — worth a hint under that input.

**Existing categories are already translated.** The migration renamed the old
`title_ru`/`title_uz` columns into `name_ru`/`name_uz` (keeping every
translation entered so far) and backfilled `name_en` from `name`. Nothing needs
a data-entry pass before the new form ships.

| `offersPackageChoice` | `boolean` | **Derived.** Whether the seller bot asks "Штука or Комплект?" for this category (`true` only when both package codes are set). |
| `productsCount` | `number` | Buyer-catalog parts linked **directly** to this node (not recursive). |
| `listingsCount` | `number` | Supply-side products **+ drafts** pointing here. **This is what blocks a hard delete.** |
| `children` | `AdminCategoryTreeNode[]` | Only on `GET /tree`. |

There is still no `description` field on a category.

**Read-only, don't build editors for them:** `fiscalConfigured`,
`fiscalByOilType`, `offersPackageChoice`, `productsCount`, `listingsCount`,
`level`, `id`. All six are derived server-side; sending any of them is either
ignored (not in a DTO) or a `400` (`level` — not whitelisted at all).

### 1.4 Endpoints

All under `@Controller('v1/admin/categories')` unless noted.

| # | Method | URL | Purpose |
|---|---|---|---|
| 1 | `GET` | `/v1/admin/categories` | Flat, filterable list |
| 2 | `GET` | `/v1/admin/categories/tree` | Full nested forest |
| 3 | `GET` | `/v1/admin/categories/:id` | One node |
| 4 | `POST` | `/v1/admin/categories` | Create |
| 5 | `PATCH` | `/v1/admin/categories/:id` | Partial update (incl. re-parent, fiscal fields) |
| 6 | `POST` | `/v1/admin/categories/:id/activate` | Activate |
| 7 | `POST` | `/v1/admin/categories/:id/deactivate` | Deactivate |
| 8 | `PATCH` | `/v1/admin/categories/:id/move` | Re-parent + reorder |
| 9 | `DELETE` | `/v1/admin/categories/:id` | Hard delete (guarded) |
| 10 | `PATCH` | `/v1/admin/products/bulk-move` | Reassign many buyer parts to one category |

**#10 lives on a different controller** (`/v1/admin/products`, not
`/v1/admin/categories`) — Nest allows exactly one controller per base path,
and this route is grouped with the product console by path rather than by
domain. It delegates to the same category service underneath.

#### 1 — `GET /v1/admin/categories`

Query (`ListCategoriesQueryDto`), all optional, AND-combined:

- `parentId` — pass the **literal string `"null"`** for roots only. Omitting
  it applies no parent filter at all. (These are different!)
- `level` — integer ≥ 0.
- `isActive` — `true` / `false` (string or boolean both accepted).

Ordered by `level`, then `sortOrder`, then `name`.

```
GET /v1/admin/categories?parentId=other&isActive=true
→ 200 { "success": true, "data": [ …nodes… ], "meta": { "total": 4 } }
```

#### 2 — `GET /v1/admin/categories/tree`

No query params. Returns the whole forest nested via `children`, each node
carrying the full field set from [1.2](#12-fields) including the fiscal flags.
Use this to render the tree view in one request.

#### 3 — `GET /v1/admin/categories/:id`

`404` if missing. Returns a flat node (no `children`).

#### 4 — `POST /v1/admin/categories`

Request (`CreateCategoryDto`):

| Field | Required | Notes |
|---|---|---|
| `nameRu` | ✅ | 1–160 chars, non-blank. Russian display name. |
| `nameUz` | ✅ | 1–160 chars, non-blank. Uzbek (Latin) display name. |
| `nameEn` | ✅ | 1–160 chars, non-blank. English display name. |
| `name` | ❌ | Internal label. Defaults to `nameEn`; the console need not send it. |
| `slug` | ❌ | ≤96 chars. Derived from `nameEn` when omitted (a Cyrillic-only name slugifies to nothing). Becomes the `id`. |
| `parentId` | ❌ | `null`/omitted = root |
| `iconKey` | ❌ | ≤48 |
| `color` | ❌ | ≤16 |
| `sortOrder` | ❌ | integer ≥ 0, default 0 |
| `mainCategory` | ❌ | `PartMainCategory` enum — omit for "Другое" children |
| `mxik` | ❌ | Exactly 17 digits. See [1.7](#17-the-fiscal-fields) for the combination rule. |
| `packageCodeSingle` | ❌ | 1–20 digits. |
| `packageCodeSet` | ❌ | 1–20 digits. |

**There is no `level` field.** It is computed as `parent.level + 1`. Sending
one is a `400` (not whitelisted).

**Response** — `201`, the created node (all fields from [1.2](#12-fields)).

**Errors:** `400` a missing/blank localized name, an unslugifiable `nameEn`,
invalid body, or half-configured fiscal data (see
[1.7](#17-the-fiscal-fields)) · `404` parent not found · `409` slug already in
use.

```http
POST /v1/admin/categories
{ "nameRu": "Мотоциклетные масла", "nameUz": "Mototsikl moylari",
  "nameEn": "Motorcycle Oil", "parentId": "other", "sortOrder": 1 }
```
```jsonc
// 201
{ "success": true,
  "data": { "id": "motorcycle-oil", "name": "Motorcycle Oil",
            "nameRu": "Мотоциклетные масла", "nameUz": "Mototsikl moylari",
            "nameEn": "Motorcycle Oil", "slug": "motorcycle-oil",
            "parentId": "other", "level": 1, "sortOrder": 1, "iconKey": null,
            "color": null, "isActive": true, "mainCategory": null,
            "mxik": null, "packageCodeSingle": null, "packageCodeSet": null,
            "fiscalConfigured": false, "fiscalByOilType": false,
            "offersPackageChoice": false,
            "productsCount": 0, "listingsCount": 0 } }
```

#### 5 — `PATCH /v1/admin/categories/:id`

Body (`UpdateCategoryDto`), every field optional; only what you send is
written: `nameRu`, `nameUz`, `nameEn`, `name`, `slug`, `iconKey`, `color`,
`parentId` (`null` promotes to root), `sortOrder`, `isActive`, `mainCategory`,
`mxik`, `packageCodeSingle`, `packageCodeSet`.

The three localized names may be patched one at a time, but **none of them can
be blanked or nulled** — see [1.3](#13-the-three-localized-names).

Any of the three fiscal fields accepts an explicit `null` to **clear** it
(distinct from omitting the field, which leaves it untouched). See
[1.7](#17-the-fiscal-fields) for the rule the server enforces on the resulting
combination.

A `parentId` change goes through the same cycle guard as `/move` and
re-derives `level` for the node **and its whole subtree**.

**Errors:** `400` invalid body, a blank/`null` localized name, would create a
cycle, or leaves fiscal data half-configured · `404` no such category or target
parent · `409` slug in use.

#### 6 / 7 — activate / deactivate

`POST /v1/admin/categories/:id/activate` · `POST …/deactivate`. No body.
Returns the updated node. `404` if missing.

**Prefer deactivate over delete.** Deactivating a parent hides its entire
subtree from the bot and the buyer, because every read filters `isActive` at
each level. It is fully reversible.

#### 8 — `PATCH /v1/admin/categories/:id/move`

Body (`MoveCategoryDto`): `parentId` (required key, `null` = promote to
root), `sortOrder` (optional).

Rejects with `400` if the new parent is the category itself or one of its own
descendants (cycle guard), or if the move would exceed the depth cap.

#### 9 — `DELETE /v1/admin/categories/:id`

Optional `?reassignTo=<categoryId>` to move referencing **buyer parts**
first.

Refuses with `409` when:
- supply-side products **or drafts** reference it (`listingsCount > 0`) —
  deactivate instead; there is no reassignment path for these, only for buyer
  parts;
- it still has child categories;
- it is `cat_uncategorized`;
- buyer parts reference it and no `reassignTo` was given.

Refuses with `400` when `reassignTo` equals the id being deleted.
Refuses with `404` when the category or the `reassignTo` target doesn't exist.

**Response** — `200 { success: true, data: { deleted: "<id>", reassigned: <n> } }`.

#### 10 — `PATCH /v1/admin/products/bulk-move`

Reassigns many **buyer-catalog parts** (not categories, not supply-side
products) to one target category, in a single transaction — all-or-nothing.

Body (`BulkMoveProductsDto`):

| Field | Required | Notes |
|---|---|---|
| `productIds` | ✅ | 1–1000 unique part ids. |
| `targetCategoryId` | ✅ | Must exist. |

**Response** — `200 { success: true, data: { moved: <n> } }`.

**Errors:** `400` invalid body (empty/oversized/duplicate `productIds`) ·
`404` no such target category.

Use this for a "move N selected products to category X" bulk action in the
product list — it is **not** for reorganizing the category tree itself.

### 1.5 Reordering

There is still **no dedicated reorder endpoint and no bulk-reorder**. Set
`sortOrder` per node via `PATCH /:id` or `PATCH /:id/move`. For drag-and-drop,
issue one `PATCH` per moved sibling. Ties break by `name`.

### 1.6 No audit trail for categories

**Category writes are not audited.** Unlike dealers (see
[Part 2](#25-audit-trail)), there is no `AdminAudit` entry, no actor, no
before/after snapshot for any category create/update/move/delete/activate.
Do not design a "history" or "changed by" panel for categories — the data to
back it does not exist. If the business needs one, that is a new backend
requirement.

### 1.7 The fiscal fields

**Why this exists.** Payme (the payment provider) requires every product line
on a receipt to carry an MXIK/ИКПУ classification code and a Tasnif package
code. A category that has neither cannot have its products sold through
Payme at all — checkout is refused for them, not silently allowed with a
missing code.

**The three legal states of a category**, enforced by the server on every
create/update — a request that doesn't match one of these is rejected with
`400`, never silently stored half-done:

| State | `mxik` | `packageCodeSingle` | `packageCodeSet` | Meaning |
|---|---|---|---|---|
| Unconfigured | `null` | `null` | `null` | Products in this category cannot be paid for online yet. |
| Configured, one form | set | set | `null` | Sold only as "Штука" (a single item) — the seller bot never asks. |
| Configured, two forms | set | set | set | Sold as either "Штука" or "Комплект / набор" — the seller bot asks which. |

Concretely: `packageCodeSet` alone (without the other two) is rejected;
`mxik` without `packageCodeSingle` is rejected; any field can be cleared by
sending it as explicit `null`, but the *result* must still be one of the
three rows above.

**Editing the form:**
- Render `mxik` / `packageCodeSingle` / `packageCodeSet` as one grouped
  control, not three independent fields, so a user can't submit a partial
  combination and get a confusing `400`.
- An empty input should be sent as `null` (clear), not `""` — the server
  treats a blank string the same as `null` for these three fields, but sending
  `null` explicitly is what the DTOs document and is unambiguous.
- Show `fiscalConfigured` as a status badge ("Ready for Payme" / "Not
  configured") rather than re-deriving the rule client-side — it is exactly
  `mxik && packageCodeSingle` (with one exception below), computed the same
  way for the console, the seller bot, and the receipt builder, so re-deriving
  it risks disagreeing with the backend.

**The oil exception — `fiscalByOilType`.** Motor-oil categories are
classified by the product's own **base composition** (synthetic /
semi-synthetic / mineral), not by category. A category where
`fiscalByOilType: true` will show `mxik`/`packageCodeSingle`/`packageCodeSet`
all `null` **and still be legitimately configured** — its `fiscalConfigured`
is `true` even though the three code fields are empty, because its products
resolve their codes from `oilType` instead. **Do not show the "not
configured" warning for these categories, and do not let an operator type
codes into fields that would be ignored.** Detect this case from
`fiscalByOilType`, not by category name or id.

### 1.8 What happens on edit / move / activate — and caching

| Admin action | Effect |
|---|---|
| Rename | Display name changes everywhere. **Safe** — nothing keys on names. |
| Change slug | Changes `slug`, **not** the `id` of an existing row. Existing listings keep pointing at the same `id`. |
| Edit fiscal fields | Every existing product in the category becomes payable (or unpayable) at once — no product row is touched. |
| Move to another parent | Re-parents, re-derives `level` for the node and its whole subtree. Cycle-guarded. |
| Reorder | `sortOrder` changes button/grid order. |
| Deactivate | Disappears from bot and buyer immediately on next read. Existing listings keep their `categoryId`. |
| Reactivate | Reappears. |

**Caching — what the frontend must know:** category reads are cached
server-side (Redis, 300 s TTL), but **every admin write explicitly
invalidates** the affected keys. You do not need to bust anything, pass
cache-busting params, or delay the UI. After a successful `2xx`, a re-fetch
returns fresh data. Do **not** implement your own category cache with a
longer lifetime.

### 1.9 Checklist — Categories

- [ ] Render the tree from `GET /v1/admin/categories/tree`
- [ ] **Three name inputs** (RU / UZ / EN) on both the create and the edit form
- [ ] **Block submit + highlight the field** while any of the three is empty or whitespace-only
- [ ] Display node names from `nameRu`/`nameUz`/`nameEn` — never from the internal `name`
- [ ] Create a child: `POST /v1/admin/categories` — never send `level` or `id`
- [ ] Edit: `PATCH /v1/admin/categories/:id` (partial) — a name may be changed, never blanked
- [ ] Move: `PATCH /v1/admin/categories/:id/move` — handle `400` cycle errors
- [ ] Activate / deactivate: `POST /:id/activate` · `/deactivate` — prefer over delete
- [ ] Ordering: `sortOrder` per node; one `PATCH` per moved sibling (no bulk endpoint)
- [ ] Bulk-reassign buyer parts: `PATCH /v1/admin/products/bulk-move` (different base path)
- [ ] Fiscal fields as one grouped control; show `fiscalConfigured` as a badge, don't re-derive it
- [ ] Suppress the "not configured" warning when `fiscalByOilType: true`
- [ ] No history/audit UI for categories — the data doesn't exist
- [ ] Errors: `400` validation (incl. a missing/blank localized name)/cycle/half-configured-fiscal · `401` no token · `403` role · `404` missing · `409` slug in use / delete blocked
- [ ] Show `message` as a toast/banner + `requestId`, not a per-field error map — only one problem comes back at a time
- [ ] Do not add a "product kind" control — OTHER children are taxonomy only
- [ ] Do not cache categories beyond the request; server invalidates on write

---

## PART 2 — Dealer management (`/v1/admin/dealers`)

Admin/operator console over `CatalogSeller` — the **same table** the public
storefront (`GET /v1/dealers`) reads. A change here is visible to buyers
immediately.

### 2.1 Fields

**List row** (`GET /v1/admin/dealers` and the summary embedded in detail):

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Slug of the name, deduplicated with a numeric suffix if needed. Server-generated on create, never sent by the client. |
| `name` | `string` | Storefront name. |
| `city` | `string \| null` | City + region, free text. |
| `brandColor` | `string \| null` | Hex accent, `#RRGGBB[AA]`. Falls back to the legacy `color` storefront field for dealers created before this field existed — you always get a value or `null`, never need to check both. |
| `logoUrl` | `string \| null` | Uploaded logo (see [2.4](#24-logo-upload)). |
| `initial` | `string \| null` | Monogram letter shown when no logo is set. |
| `gmvUzs` | `number` | Lifetime gross merchandise value, whole UZS. |
| `orders` | `number` | Lifetime order count. |
| `skus` | `number` | Live buyer-catalog part count for this dealer. |
| `certified` | `boolean` | "MATOR Certified" badge. |
| `lowestPrice` | `boolean` | "Lowest price" badge. |
| `status` | `"active" \| "pending" \| "suspended"` | Lowercase on the wire. |
| `joinedAt` | ISO 8601 | |
| `updatedAt` | ISO 8601 | |

**Detail row** (`GET /v1/admin/dealers/:id`) — a strict superset, adds:

| Field | Type | Notes |
|---|---|---|
| `email` | `string \| null` | |
| `phone` | `string \| null` | E.164. |
| `rating` | `number` | |
| `years` | `number \| null` | Years in business. |
| `certifiedPartner` | `boolean` | Internal "curated by operator" flag (`isCurated`) — distinct from the public `certified` badge; see [2.2](#22-create). |
| `tin` | `string \| null` | ИНН (9 digits) or ПИНФЛ (14 digits). `null` = not configured. |
| `vatPercent` | `number \| null` | e.g. `12`. `null` ≠ `0` — "not configured" is a different fact from "0% VAT" and only the former blocks Payme checkout. |
| `fiscalConfigured` | `boolean` | **Derived:** `tin != null && vatPercent != null`. Whether this dealer's products can go through Payme checkout at all. |
| `suspendedReason` | `string \| null` | Only populated while `status === "suspended"`; `null` at every other status, even if the dealer was once suspended with a reason. |

### 2.2 Endpoints

| # | Method | URL | Purpose |
|---|---|---|---|
| 1 | `POST` | `/v1/admin/dealers` | Create a curated dealer |
| 2 | `POST` | `/v1/admin/dealers/logo` | Upload a brand logo (multipart) |
| 3 | `GET` | `/v1/admin/dealers` | Paginated, filterable, searchable list |
| 4 | `GET` | `/v1/admin/dealers/:id` | One dealer (detail) |
| 5 | `PATCH` | `/v1/admin/dealers/:id` | Update editable fields |
| 6 | `POST` | `/v1/admin/dealers/:id/approve` | pending → active |
| 7 | `POST` | `/v1/admin/dealers/:id/suspend` | active → suspended |
| 8 | `POST` | `/v1/admin/dealers/:id/reactivate` | suspended → active |

#### 1 — `POST /v1/admin/dealers`

Only `name` is required. **A dealer created here is treated as a real,
vetted storefront**: unless the body overrides it, it lands
`status: active`, `certified: true`, and is internally marked curated
(`isCurated`) — the three conditions the public storefront filters on — so it
appears in the app's "MATOR Certified" rail **immediately** on creation, with
no separate publish step.

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | ≤160 chars. |
| `city` | ❌ | ≤120 chars. |
| `email` | ❌ | ≤255 chars. |
| `phone` | ❌ | E.164, ≤20 chars. |
| `brandColor` | ❌ | Hex, ≤9 chars. |
| `initial` | ❌ | ≤4 chars. Derived from `name`'s first letter when omitted. |
| `logoUrl` | ❌ | From endpoint #2 — upload first, pass the URL here. |
| `orders` | ❌ | **Pre-formatted display string** for the storefront card, e.g. `"18k+"` — not a number, not the real lifetime count. |
| `years` | ❌ | Integer, 0–200. |
| `tin` | ❌ | 9 or 14 digits. See [2.3](#23-tax-data-tin--vatpercent). |
| `vatPercent` | ❌ | 0–100, ≤2 decimals. See [2.3](#23-tax-data-tin--vatpercent). |
| `certified` | ❌ | Default `true` **only if the dealer lands `active`**; forced `false` for any non-active status regardless of what you send. |
| `lowestPrice` | ❌ | Default `false`. Same active-only rule as `certified`. |
| `status` | ❌ | `"active" \| "pending" \| "suspended"`. Default `active`. |

**Response** — `201`, the full detail shape ([2.1](#21-fields)).

Note the `orders` field here is a **string** (`"18k+"`) for card display,
while the list/detail response's `orders` field is the **real integer**
count — they are not the same thing despite the shared name. Don't wire a
numeric-orders display straight to this create field.

#### 2 — `POST /v1/admin/dealers/logo`

`multipart/form-data`, field name `logo` (also accepts `file` or `image` for
compatibility with generic upload widgets). JPEG/PNG/WebP, ≤ 5 MB. Always
stored and delivered as PNG regardless of source format.

**Response** — `200 { "logoUrl": "https://…" }`. This is **not** wrapped in
`{success, data}` — it's a bare object, matching the avatar-upload endpoint's
shape. Pass the returned URL as `logoUrl` on create or update; storage and
the dealer row write are separate calls, so upload first, then create/PATCH.

**Errors:** `415` no file / unsupported type · `413` over 5 MB.

#### 3 — `GET /v1/admin/dealers`

| Query param | Type | Default | Notes |
|---|---|---|---|
| `page` | int ≥ 1 | `1` | |
| `limit` | int 1–100 | `20` | |
| `status` | `"active" \| "pending" \| "suspended"` | — | Single value, not a list. |
| `search` | string ≤120 | — | Matches store name, city, email (all substring, case-insensitive) and phone (digits-only match, from 4+ digits typed). |
| `sort` | `"joinedAt" \| "name" \| "gmvUzs" \| "orders" \| "skus"` | `"joinedAt"` | |
| `order` | `"asc" \| "desc"` | `"desc"` | |

Newest dealers first by default. `skus` sorts by the live relation count, not
a stored column — same cost either way from the frontend's perspective.

**Debounce `search`.** Every keystroke that fires a request is a full paginated
DB query (name/city/email substring match, plus a digit-only phone match) —
there is no server-side request coalescing. Debounce the search input
**300–500 ms** after the last keystroke before calling this endpoint, and
cancel/ignore any in-flight response that isn't for the latest query term (a
slow earlier request completing after a faster later one would otherwise
flash stale results).

**Response:**

```jsonc
{
  "success": true,
  "data": [ /* list rows, see 2.1 */ ],
  "meta": { "page": 1, "limit": 20, "totalItems": 1, "totalPages": 1 }
}
```

#### 4 — `GET /v1/admin/dealers/:id`

`404` if missing. Returns the detail shape ([2.1](#21-fields)).

#### 5 — `PATCH /v1/admin/dealers/:id`

**Every field is optional, but the body must not be entirely empty** — an
empty `{}` (or one where every field is `undefined`) is rejected with `400
"Nothing to update"`.

| Field | Notes |
|---|---|
| `name` | Cannot be set to an empty/blank string — `400`. |
| `city`, `email`, `phone`, `brandColor`, `initial`, `logoUrl`, `orders`, `years` | Presentation fields. Empty string clears to `null` (except `name`); `years` is `null`-able directly. |
| `tin` | 9 or 14 digits, or empty string to clear. See [2.3](#23-tax-data-tin--vatpercent). |
| `vatPercent` | 0–100, ≤2 decimals. See [2.3](#23-tax-data-tin--vatpercent). No way to *clear* it back to `null` via this endpoint — only to change its value. |
| `certified`, `lowestPrice` | Badges. Can be toggled independent of `status` here — but see [2.5](#25-audit-trail) for what happens on suspend. |
| `status` | `"active" \| "pending" \| "suspended"`. **Goes through the same transition table** as the dedicated approve/suspend/reactivate endpoints (see [2.6](#26-status-state-machine)) — you cannot use PATCH to skip a state those endpoints wouldn't allow either. |
| `reason` | Only meaningful when `status` is being set to `"suspended"` in the same request; ignored otherwise (including when suspending via the dedicated endpoint — that takes its own body). |

**Response** — `200`, the detail shape.

**Errors:** `400` invalid field/value, empty body, illegal status transition,
or blank `name` · `404` no such dealer.

**A field sent equal to its current value is not a change** and produces no
audit entry — see [2.5](#25-audit-trail). This means re-submitting a form
with no actual edits is safe and silent, not an error and not a spurious
history row.

#### 6 / 7 / 8 — approve / suspend / reactivate

```
POST /v1/admin/dealers/:id/approve      pending   → active
POST /v1/admin/dealers/:id/suspend      active    → suspended     { reason?: string, ≤500 chars }
POST /v1/admin/dealers/:id/reactivate   suspended → active
```

All three: `200`, the detail shape. `400` if the dealer isn't in the required
starting state (message names both states). `404` if missing.

**Suspending a dealer clears its `certified` and `lowestPrice` badges
server-side**, unconditionally — a suspended storefront can never keep
showing as "MATOR Certified" or "Lowest price." **Reactivating does NOT
restore them.** The operator must consciously re-award the badges after
reactivation via `PATCH`; this is deliberate (re-earned, not automatic), not
a bug to route around. Surface this in the UI — e.g. a confirmation dialog on
suspend that says the badges will be removed, and a reminder on reactivation
that they're off.

### 2.3 Tax data (`tin` / `vatPercent`)

Both fields exist **solely** to make a dealer's products payable through
Payme (`PaymeFiscalService`). There is no automatic tax lookup and the
Telegram seller bot never collects them — this admin form is the **only**
place they're entered.

- Optional at every stage: a dealer can be created, approved, and sell
  products with `tin`/`vatPercent` both `null`. Only the **checkout** step for
  their products is blocked until both are set — nothing else in the pipeline
  requires them.
- Filling them in via `PATCH` makes **every existing product** of that dealer
  payable at once. No product row is touched or needs republishing.
- `tin` format: `^(\d{9}|\d{14})$` — 9 digits (ИНН, legal entity) or 14 digits
  (ПИНФЛ, individual). Leading zeros are significant; treat it as a string
  input, never coerce to a number.
- `vatPercent`: 0–100, up to 2 decimal places. `0` is a valid, fully-configured
  rate — **do not treat `0` as "not set."** Only `null` means unconfigured.
- Render `fiscalConfigured` (detail response only) as a status indicator
  rather than checking `tin != null && vatPercent != null` yourself — same
  reasoning as the category fiscal badge: one server-computed source of
  truth shared with the receipt builder.

### 2.4 Logo upload

Reuses the same image pipeline as user avatars: ≤5 MB, JPEG/PNG/WebP in,
always PNG out, hosted on Cloudinary. Two-step flow — there is no
single-request "create dealer with logo file attached":

1. `POST /v1/admin/dealers/logo` (multipart) → `{ logoUrl }`
2. Pass that `logoUrl` in the `POST /v1/admin/dealers` or `PATCH
   /v1/admin/dealers/:id` body.

A failed step 2 (e.g. validation error elsewhere in the form) does not delete
the already-uploaded image — the upload and the row write are independent.
This is a minor known tradeoff (an orphaned upload costs storage, not
correctness); no cleanup action is needed from the frontend.

**UI recommendation, not a server rule:** the backend enforces only file
type and byte size (above) — it does **not** check aspect ratio or pixel
dimensions, and does not crop or resize on upload; whatever aspect ratio is
uploaded is what `logoUrl` serves. To keep dealer cards visually consistent,
the upload widget itself should constrain the picker to a **square 1:1**
crop and reject/warn below roughly **200×200 px**, since a non-square or very
small source will be stretched or blurred by any fixed-size `<img>` tile in
the dealer list/detail views. Enforce this client-side only — do not expect a
`400` from the API for a rectangular or low-res logo.

### 2.5 Audit trail

**Every dealer mutation is audited**, in sharp contrast to categories
([1.6](#16-no-audit-trail-for-categories)). This asymmetry is intentional —
dealer changes are moderation actions with compliance weight; category edits
are taxonomy housekeeping.

There is currently **no dedicated read endpoint in this document's scope**
for the dealer audit log — if the console needs a visible "history" tab for a
dealer, that is a separate backend request (the data is being written; ask
what's needed to expose it via API).

What is written, for design purposes (so you know what granularity to expect
if/when a history view is built):

| Action | When |
|---|---|
| `DEALER_CREATED` | On `POST /v1/admin/dealers`. |
| `DEALER_CERTIFIED_ENABLED` / `_DISABLED` | `certified` toggled, via PATCH or the suspend-badge-clear. |
| `DEALER_LOWEST_PRICE_ENABLED` / `_DISABLED` | Same, for `lowestPrice`. |
| `DEALER_APPROVED` | pending → active. |
| `DEALER_SUSPENDED` | active → suspended (reason attached). |
| `DEALER_REACTIVATED` | suspended → active. |
| `DEALER_UPDATED` | Any presentation field or tax field (`tin`/`vatPercent`) change, batched as one entry per PATCH call — not one entry per field. |

A field PATCHed to its current value produces **no** entry (see
[2.2](#22-endpoints) #5) — the trail reflects actual changes only.

### 2.6 Status state machine

```
PENDING  ──approve──▶  ACTIVE  ──suspend──▶  SUSPENDED
                          ▲                       │
                          └───────reactivate───────┘
```

Only these three transitions are legal, in either direction of travel shown.
There is no direct `PENDING → SUSPENDED`. Any other requested transition —
via the dedicated endpoints **or** via `PATCH {status: …}`, both routed
through the same table — is `400` with a message naming the current and
requested state.

### 2.7 Checklist — Dealers

- [ ] Create: `POST /v1/admin/dealers` — only `name` required; know that it defaults to **live and certified**
- [ ] Upload logo FIRST (`POST /v1/admin/dealers/logo`), then pass `logoUrl` into create/update
- [ ] Constrain the logo picker to a square 1:1 crop, ≥200×200 px — client-side only, the API doesn't check this
- [ ] List: `GET /v1/admin/dealers` with `page`/`limit`/`status`/`search`/`sort`/`order`
- [ ] Debounce `search` 300–500 ms and drop stale in-flight responses
- [ ] Detail is a superset of the list row — reuse the list-row renderer, add the extra fields
- [ ] Update: `PATCH /v1/admin/dealers/:id` — body cannot be empty; treat `tin`/`vatPercent` as their own grouped section
- [ ] `vatPercent: 0` is configured, not empty — only `null` is "not set"
- [ ] Status changes: prefer the dedicated approve/suspend/reactivate endpoints; PATCH `status` is the same rules, not a shortcut around them
- [ ] Warn on suspend that certified/lowest-price badges will be cleared; they do NOT come back on reactivate
- [ ] `orders` means two different things depending on endpoint — a formatted string on create, a real count on list/detail
- [ ] No dealer-history UI yet — the audit data exists but has no read endpoint in scope
- [ ] Errors: `400` validation/empty-body/illegal-transition · `401` no token · `403` role · `404` missing · `413`/`415` on logo upload
- [ ] Show `message` as a toast/banner + `requestId`, not a per-field error map — only one problem comes back at a time

---

## Frontend API Contract (condensed)

```http
# ── Categories (Bearer admin token; SUPER_ADMIN | MANAGER | OPERATOR) ──
GET    /v1/admin/categories?parentId=&level=&isActive=
GET    /v1/admin/categories/tree
GET    /v1/admin/categories/:id
POST   /v1/admin/categories        { nameRu, nameUz, nameEn, name?, slug?, parentId?, iconKey?, color?, sortOrder?,
                                      mainCategory?, mxik?, packageCodeSingle?, packageCodeSet? }
PATCH  /v1/admin/categories/:id    { …same fields, all optional; mxik/packageCodeSingle/
                                      packageCodeSet accept null to clear }
POST   /v1/admin/categories/:id/activate
POST   /v1/admin/categories/:id/deactivate
PATCH  /v1/admin/categories/:id/move    { parentId, sortOrder? }
DELETE /v1/admin/categories/:id?reassignTo=
PATCH  /v1/admin/products/bulk-move     { productIds[], targetCategoryId }   # different base path

# ── Dealers (Bearer admin token; SUPER_ADMIN | MANAGER | OPERATOR) ──
POST   /v1/admin/dealers           { name, city?, email?, phone?, brandColor?, initial?,
                                      logoUrl?, orders?, years?, tin?, vatPercent?,
                                      certified?, lowestPrice?, status? }
POST   /v1/admin/dealers/logo      multipart, field "logo" (aliases: file, image) → { logoUrl }
GET    /v1/admin/dealers?page=&limit=&status=&search=&sort=&order=
GET    /v1/admin/dealers/:id
PATCH  /v1/admin/dealers/:id       { name?, city?, email?, phone?, brandColor?, initial?,
                                      logoUrl?, orders?, years?, tin?, vatPercent?,
                                      certified?, lowestPrice?, status?, reason? }
POST   /v1/admin/dealers/:id/approve
POST   /v1/admin/dealers/:id/suspend      { reason? }
POST   /v1/admin/dealers/:id/reactivate
```

**Category node:** `id, nameRu, nameUz, nameEn, name, slug, parentId, level, sortOrder, iconKey,
color, isActive, mainCategory, mxik, packageCodeSingle, packageCodeSet,
fiscalConfigured, fiscalByOilType, offersPackageChoice, productsCount,
listingsCount, children[]`
Envelope: `{ success, data, meta? }`

**Dealer list row:** `id, name, city, brandColor, logoUrl, initial, gmvUzs,
orders, skus, certified, lowestPrice, status, joinedAt, updatedAt`
**Dealer detail** adds: `email, phone, rating, years, certifiedPartner, tin,
vatPercent, fiscalConfigured, suspendedReason`
Envelope: `{ success, data, meta? }`

**Error body** (every non-2xx): `{ code, message, requestId }`

**Not audited:** categories. **Fully audited (no read endpoint yet):** dealers.
**No `description` field:** categories. **No bulk reorder:** categories.
