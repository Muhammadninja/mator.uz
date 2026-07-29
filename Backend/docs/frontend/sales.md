# Sales — Frontend Integration Guide

**Audience:** frontend developers (mobile app + admin panel).
**Status:** backend implemented and merged. Product/cart/order price integration is
**not yet wired** — see [Future integration](#future-integration).

---

## Overview

A **Sale** is an automatic discount campaign. An operator creates it in the admin
panel; the backend applies it on its own. The user does nothing to "activate" a
sale, and the app does not opt in to one.

Sales are a **completely separate system from promo codes**. They share no table,
no endpoint and no code path.

| | Sales | Promo codes |
|---|---|---|
| How it starts | Automatic — always on while the campaign runs | User types a code |
| What it discounts | A **product** (per line item) | The **cart** as a whole |
| Who creates it | Admin panel | Backend config |
| Where it lives | `/v1/sales`, `/v1/admin/sales` | `POST /v1/cart/promo` |
| Stacking | Never — exactly one sale per product | Independent of sales |
| Field on the order | *(pending integration)* | `promoCode`, `discountUzs` |

Four rules that drive everything below:

1. **Sales are automatic.** There is no "apply sale" call. If a campaign covers a
   product, its price is already discounted when you receive it.
2. **Promo codes are manual** and unrelated. Applying one does not affect which
   sale is chosen, and a sale does not consume or invalidate a promo code.
3. **Multiple sales never stack.** If three campaigns cover one product, exactly
   **one** is applied. Two 20% sales give 20% off — never 36% or 40%.
4. **The backend always returns the final price.** The app renders what it is
   given and never computes a discount itself. See
   [Frontend behaviour](#frontend-behaviour).

---

## Public API

### `GET /v1/sales`

Returns the campaigns that are **live right now**. Read-only, unauthenticated.

This endpoint is **informational** — use it for merchandising surfaces ("Summer
Sale is on"), banners and campaign landing pages. It is **not** how you price
anything: prices arrive already discounted from the product/cart endpoints.

**Request**

```http
GET /v1/sales
```

No parameters, no auth header, no pagination.

A sale appears here only when **all** of the following hold at request time:

- `isActive` is `true`
- `startAt` is in the past
- `endAt` is `null` (open-ended) or in the future
- the sale has not been deleted

Ordering: `priority` descending, then most recently started, then `id`. Capped at
100 rows (far above any realistic number of concurrent campaigns).

**Response** — `200 OK`

```json
{
  "items": [
    {
      "id": "sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z",
      "title": "Summer brake sale",
      "description": "15% off all brake pads",
      "discountType": "PERCENT",
      "discountValue": 15,
      "scopeType": "CATEGORIES",
      "startAt": "2026-07-01T00:00:00.000Z",
      "endAt": "2026-08-31T23:59:59.000Z"
    },
    {
      "id": "sale_01HXD9M2K4P6R8T0V2X4Z6B8D",
      "title": "Winter clearance",
      "description": null,
      "discountType": "FIXED",
      "discountValue": 50000,
      "scopeType": "ALL_PRODUCTS",
      "startAt": "2026-07-15T00:00:00.000Z",
      "endAt": null
    }
  ]
}
```

**Fields**

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable identifier, prefix `sale_`. |
| `title` | `string` | Display name. Safe to show to users. |
| `description` | `string \| null` | Optional longer copy. Handle `null`. |
| `discountType` | `"PERCENT" \| "FIXED"` | How to read `discountValue`. |
| `discountValue` | `number` | Percent: `0 < v <= 100`. Fixed: whole UZS. |
| `scopeType` | enum | What the campaign covers — see [Sale scopes](#sale-scopes). |
| `startAt` | ISO 8601 string | Campaign start (UTC). |
| `endAt` | ISO 8601 string `\| null` | `null` = open-ended. |

**Deliberately absent:** `priority`, `isActive`, `targetIds`, `targetCount`,
`status`, `deletedAt`, `createdAt`, `updatedAt`. These are operational fields for
the admin console. In particular there are **no target ids**, so the app cannot
determine which products a scoped sale covers — that is intentional, because
determining coverage is the backend's job.

> **Do not** use `discountValue` from this endpoint to compute a price. It tells
> you what to *advertise*, not what anything costs. A product covered by this sale
> may be covered by a higher-priority one and receive a different discount.

---

## Admin API

All admin endpoints require an **admin-panel** bearer token (not a mobile app user
token — the two are separate and an app token is rejected outright).

```http
Authorization: Bearer <admin access token>
```

Roles accepted: `SUPER_ADMIN`, `MANAGER`, `OPERATOR`.

**Shared error responses**

| Status | `code` | When |
|---|---|---|
| `400` | `VALIDATION_FAILED` | Invalid body or query parameter. |
| `401` | `UNAUTHORIZED` | Missing/invalid/expired admin token. |
| `403` | `FORBIDDEN` | Token is valid but the role is not permitted. |
| `404` | `NOT_FOUND` | No such sale, or it has been deleted. |

**Error body shape** — every error, including validation errors:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "discountValue must not exceed 100 for a PERCENT sale",
  "requestId": "3AA7FC"
}
```

> ⚠️ **Only the first validation message is returned.** If a body has three
> problems, `message` names one of them. Fix it, resubmit, and you may get the
> next. Do not build UI that expects an array of field errors.
>
> `requestId` is present on most responses — log it, and quote it in bug reports.

---

### `GET /v1/admin/sales`

**Purpose:** the campaign list for the admin console. Paginated, filterable,
searchable.

**Request**

```http
GET /v1/admin/sales?page=1&limit=20&status=active&sort=startAt&order=desc
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `page` | int ≥ 1 | `1` | |
| `limit` | int 1–100 | `20` | Values above 100 are rejected. |
| `status` | enum | — | `active`, `scheduled`, `expired`, `inactive`, `deleted`. |
| `scopeType` | enum | — | `ALL_PRODUCTS`, `PRODUCTS`, `CATEGORIES`, `DEALERS`. |
| `search` | string ≤ 120 | — | Case-insensitive match on **title only**. |
| `isActive` | `"true"`/`"false"` | — | The raw flag, not the derived status. |
| `includeDeleted` | `"true"`/`"false"` | `"false"` | Show soft-deleted sales. |
| `sort` | enum | `createdAt` | `createdAt`, `startAt`, `endAt`, `title`, `priority`, `discountValue`. |
| `order` | `asc`/`desc` | `desc` | |

`status` filters on the **derived** lifecycle (computed from the flags and the
clock), while `isActive` filters the raw stored boolean. They are independent and
can be combined — `?isActive=false&status=active` legitimately returns nothing.

`status=deleted` implies `includeDeleted=true`; you do not need to send both.

**Response** — `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": "sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z",
      "title": "Summer brake sale",
      "description": "15% off all brake pads",
      "discountType": "PERCENT",
      "discountValue": 15,
      "scopeType": "CATEGORIES",
      "targetCount": 3,
      "startAt": "2026-07-01T00:00:00.000Z",
      "endAt": "2026-08-31T23:59:59.000Z",
      "isActive": true,
      "priority": 10,
      "status": "active",
      "deletedAt": null,
      "createdAt": "2026-06-28T09:12:00.000Z",
      "updatedAt": "2026-06-28T09:12:00.000Z"
    }
  ],
  "meta": { "page": 1, "limit": 20, "totalItems": 1, "totalPages": 1 }
}
```

The list row carries `targetCount` (how many subjects the sale targets) but not
the ids themselves — fetch the detail endpoint for those.

**Validation errors**

| `message` | Cause |
|---|---|
| `sort is not a supported sort field` | `sort` outside the whitelist. |
| `order must be asc or desc` | Bad `order`. |
| `status must be one of: active, scheduled, expired, inactive, deleted` | Bad `status`. |
| `isActive must be true or false` | Non-boolean string. |

---

### `GET /v1/admin/sales/:id`

**Purpose:** one campaign, including the ids it targets. Use this to populate an
edit form.

**Request**

```http
GET /v1/admin/sales/sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z
```

**Response** — `200 OK`. A strict **superset** of the list row: every list field,
plus `targetIds`.

```json
{
  "success": true,
  "data": {
    "id": "sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z",
    "title": "Summer brake sale",
    "description": "15% off all brake pads",
    "discountType": "PERCENT",
    "discountValue": 15,
    "scopeType": "CATEGORIES",
    "targetCount": 3,
    "targetIds": ["cat_brakes", "cat_brake_pads", "cat_brake_discs"],
    "startAt": "2026-07-01T00:00:00.000Z",
    "endAt": "2026-08-31T23:59:59.000Z",
    "isActive": true,
    "priority": 10,
    "status": "active",
    "deletedAt": null,
    "createdAt": "2026-06-28T09:12:00.000Z",
    "updatedAt": "2026-06-28T09:12:00.000Z"
  }
}
```

`targetIds` is `[]` for an `ALL_PRODUCTS` sale.

A **deleted** sale returns `404` here even though it still exists in the database.
To inspect deleted campaigns, use the list with `?status=deleted`.

---

### `POST /v1/admin/sales`

**Purpose:** create a campaign. The sale and its targets are written in one
transaction — a sale never exists with a half-written target set.

**Request**

```http
POST /v1/admin/sales
Content-Type: application/json
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string 1–160 | ✅ | |
| `description` | string ≤ 1000 | — | |
| `discountType` | `PERCENT`/`FIXED` | ✅ | |
| `discountValue` | number | ✅ | `> 0`; `<= 100` if PERCENT; max 2 decimals. |
| `scopeType` | enum | — | Defaults to `ALL_PRODUCTS`. |
| `targetIds` | string[] | conditional | Required unless `ALL_PRODUCTS`; forbidden for it. Max 500, unique. |
| `startAt` | ISO 8601 | ✅ | |
| `endAt` | ISO 8601 | — | Omit for open-ended. Must be `>= startAt`. |
| `isActive` | boolean | — | Defaults to `true`. |
| `priority` | int 0–1000 | — | Defaults to `0`. |

**Example — percentage sale on selected categories**

```json
{
  "title": "Summer brake sale",
  "description": "15% off all brake pads",
  "discountType": "PERCENT",
  "discountValue": 15,
  "scopeType": "CATEGORIES",
  "targetIds": ["cat_brakes", "cat_brake_pads", "cat_brake_discs"],
  "startAt": "2026-07-01T00:00:00.000Z",
  "endAt": "2026-08-31T23:59:59.000Z",
  "priority": 10
}
```

**Example — fixed discount across the whole catalog, open-ended**

```json
{
  "title": "Winter clearance",
  "discountType": "FIXED",
  "discountValue": 50000,
  "scopeType": "ALL_PRODUCTS",
  "startAt": "2026-11-01T00:00:00.000Z"
}
```

**Example — scheduled but not yet enabled**

```json
{
  "title": "Black Friday",
  "discountType": "PERCENT",
  "discountValue": 30,
  "startAt": "2026-11-27T00:00:00.000Z",
  "endAt": "2026-11-30T23:59:59.000Z",
  "isActive": false,
  "priority": 100
}
```

**Response** — `201 Created`, same shape as `GET /v1/admin/sales/:id`.

**Validation errors** — all `400 VALIDATION_FAILED`:

| `message` | Cause |
|---|---|
| `discountValue must be greater than 0` | Zero or negative. |
| `discountValue must not exceed 100 for a PERCENT sale` | Percent over 100. |
| `endAt must be the same as or after startAt` | Inverted window. |
| `startAt must be an ISO 8601 date-time string` | Unparseable date. |
| `discountType must be PERCENT or FIXED` | Unknown enum. |
| `targetIds is required when scopeType is CATEGORIES` | Scoped sale with no targets. |
| `targetIds must be omitted when scopeType is ALL_PRODUCTS` | Targets on a global sale. |
| `targetIds contains 2 id(s) that do not exist for scopeType PRODUCTS` | Typo'd or stale ids. |
| `property X should not exist` | Unknown field in the body. |

> **Every target id is checked for existence.** A typo is a `400`, never a
> silently created campaign that discounts nothing. Build your target picker from
> real ids (category/dealer/product endpoints) rather than free text.

---

### `PATCH /v1/admin/sales/:id`

**Purpose:** partial update. Send only the fields that change.

**Request** — every `POST` field, all optional.

```json
{ "priority": 50 }
```

```json
{
  "discountValue": 25,
  "endAt": "2026-09-30T23:59:59.000Z"
}
```

**Response** — `200 OK`, same shape as `GET /v1/admin/sales/:id`.

**Behaviour to be aware of:**

- **Cross-field rules are re-checked against the merged state.** Sending
  `{"discountValue": 150}` on an existing PERCENT sale is rejected even though the
  body alone looks fine — the rule cannot be bypassed by splitting a change across
  two requests. To go above 100 you must switch to `FIXED` **in the same body**.
- **Targets are replaced wholesale**, and only when you send `targetIds` or change
  `scopeType`. Omit both and the existing target set is left untouched. Sending
  `targetIds` replaces the entire set — it is not an append.
- **Changing `scopeType` requires new `targetIds`** (unless the new scope is
  `ALL_PRODUCTS`), because the old ids point at a different kind of entity.
- An empty body `{}` is rejected with `Nothing to update`.
- A deleted sale returns `404` — deletion is terminal and cannot be undone by
  editing.

**Ending a campaign:** `PATCH { "isActive": false }`. This is reversible and keeps
the campaign on file — prefer it to `DELETE` whenever the campaign might run again.

---

### `DELETE /v1/admin/sales/:id`

**Purpose:** retire a campaign permanently.

**This is a soft delete.** The row is stamped with `deletedAt` rather than removed,
so a campaign that ran stays on file and auditable.

**Request**

```http
DELETE /v1/admin/sales/sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z
```

**Response** — `200 OK`

```json
{
  "success": true,
  "data": { "id": "sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z", "deleted": true }
}
```

**Effects**

- Immediately excluded from `GET /v1/sales`, from the default admin list, and from
  all price calculation.
- Still retrievable via `GET /v1/admin/sales?status=deleted`, where it reports
  `status: "deleted"` and a non-null `deletedAt`.
- **Terminal.** Fetching, editing or re-deleting a deleted sale all return `404`.
  There is no restore endpoint — confirm destructively in the UI.
- **Past orders are unaffected.** Order lines store their own price snapshot and
  hold no reference to a sale.

---

## Sale model

The full admin shape. The public endpoint returns a subset (see
[Public API](#public-api)).

| Field | Type | Public? | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Stable id, prefix `sale_`. The body is time-sortable, so sorting by `id` equals sorting by creation time. |
| `title` | `string` | ✅ | Display name, 1–160 chars. |
| `description` | `string \| null` | ✅ | Optional copy, ≤ 1000 chars. **Nullable — always handle `null`.** |
| `discountType` | `"PERCENT" \| "FIXED"` | ✅ | How to interpret `discountValue`. |
| `discountValue` | `number` | ✅ | PERCENT: `0 < v <= 100`. FIXED: whole UZS, `> 0`. Up to 2 decimals. |
| `priority` | `number` | ❌ | `0`–`1000`. **The only lever over which sale wins.** Higher wins. |
| `scopeType` | enum | ✅ | `ALL_PRODUCTS`, `PRODUCTS`, `CATEGORIES`, `DEALERS`. |
| `targetCount` | `number` | ❌ | How many subjects are targeted. `0` for `ALL_PRODUCTS`. |
| `targetIds` | `string[]` | ❌ | **Detail endpoint only.** The targeted ids; `[]` for `ALL_PRODUCTS`. |
| `startAt` | ISO 8601 | ✅ | When the campaign opens. |
| `endAt` | ISO 8601 `\| null` | ✅ | When it closes. `null` = open-ended. |
| `isActive` | `boolean` | ❌ | Operator on/off switch. Reversible. |
| `status` | enum | ❌ | **Derived, not stored** — see below. |
| `deletedAt` | ISO 8601 `\| null` | ❌ | Soft-delete timestamp. `null` = not deleted. Terminal. |
| `createdAt` | ISO 8601 | ❌ | Creation time. Also tie-break #2 in selection. |
| `updatedAt` | ISO 8601 | ❌ | Last modification. |

### `status` — the derived lifecycle

`status` is computed on every read from `deletedAt`, `isActive` and the current
time. It is **not** a column, so it is always current — an expired campaign starts
reporting `expired` the moment its window closes, with no background job and no
write to the row.

Precedence, strongest first:

| `status` | Condition |
|---|---|
| `deleted` | `deletedAt` is set. Beats everything. |
| `inactive` | `isActive` is `false`. |
| `scheduled` | Enabled, but `startAt` is in the future. |
| `expired` | Enabled, but `endAt` has passed. |
| `active` | Enabled and inside the window. **Only this state discounts anything.** |

Because `deleted` and `inactive` outrank the window states, a sale whose dates
overlap today still reads `inactive` if an operator switched it off.

---

## Selection rules

When several campaigns cover the same product, the backend picks **exactly one**.
The rules, in order:

1. **Highest `priority` wins.** This is the only business-controlled lever.
2. **If priorities are equal, the oldest sale wins** (earliest `createdAt`).
3. **If `createdAt` also ties, the lowest `id` wins.**
4. **Discounts never stack.** The winner is applied once; the others are ignored
   entirely.

Rules 2 and 3 exist purely so the outcome is deterministic — the same product
prices identically on every request and every server. They are **not** policy. If
the business wants one campaign to beat another, raise its `priority`; nothing
else changes the outcome.

> **Discount size is deliberately not considered.** A percentage and a fixed amount
> cannot be compared without knowing the price — is 20% bigger than 50 000 so'm? It
> depends on the product. Ranking by size would let the winning campaign change from
> one product to the next inside a single cart. Selection is price-independent, so
> the same campaign wins for every product it covers.

### Example 1 — equal priority, oldest wins

Three campaigns all cover one GM brake pad sold by dealer #15, all at `priority: 0`:

| Campaign | Discount | `createdAt` | Scope |
|---|---|---|---|
| Summer Sale | 10% | 2026-06-01 | `ALL_PRODUCTS` |
| GM Parts | 20% | 2026-06-15 | `CATEGORIES` |
| Dealer #15 | 5% | 2026-07-01 | `DEALERS` |

On a 100 000 UZS product → **Summer Sale**, `finalPrice: 90 000`.

The oldest campaign wins even though GM Parts discounts twice as much. This is
expected: at equal priority, size is not a factor.

### Example 2 — priority overrides everything

Same three campaigns, but Dealer #15 is set to `priority: 10`:

→ **Dealer #15**, `finalPrice: 95 000` — the *smallest* discount, because it has
the highest priority.

### Example 3 — making GM Parts win

Set GM Parts to `priority: 5` (Summer and Dealer #15 stay at `0`):

→ **GM Parts**, `finalPrice: 80 000`.

### Example 4 — never stacked

Two campaigns both giving 20% cover one product:

→ 20% off. `finalPrice: 80 000` on a 100 000 item — not 64 000 (compounded) and
not 60 000 (summed).

---

## Sale scopes

`scopeType` decides which products a campaign covers. Scoped campaigns carry a
list of `targetIds`; the global one does not.

### `ALL_PRODUCTS`

Every product in the catalog. Takes **no** `targetIds` — sending them is a `400`.

```json
{
  "title": "Site-wide clearance",
  "discountType": "FIXED",
  "discountValue": 50000,
  "scopeType": "ALL_PRODUCTS",
  "startAt": "2026-11-01T00:00:00.000Z"
}
```

### `PRODUCTS`

Hand-picked products. `targetIds` are **product ids**.

```json
{
  "title": "Featured deals",
  "discountType": "PERCENT",
  "discountValue": 25,
  "scopeType": "PRODUCTS",
  "targetIds": ["part_01HX...", "part_01HY...", "part_01HZ..."],
  "startAt": "2026-07-01T00:00:00.000Z"
}
```

### `CATEGORIES`

Every product in the listed categories. `targetIds` are **category ids**.

```json
{
  "title": "Summer brake sale",
  "discountType": "PERCENT",
  "discountValue": 15,
  "scopeType": "CATEGORIES",
  "targetIds": ["cat_brakes", "cat_brake_pads"],
  "startAt": "2026-07-01T00:00:00.000Z"
}
```

> Category matching is **exact, not hierarchical**. Targeting a parent category
> does not automatically cover its children — list each category you intend to
> cover.

### `DEALERS`

Every product from the listed dealers. `targetIds` are **dealer (seller) ids**.

```json
{
  "title": "Dealer #15 promotion",
  "discountType": "PERCENT",
  "discountValue": 5,
  "scopeType": "DEALERS",
  "targetIds": ["seller_15"],
  "startAt": "2026-07-01T00:00:00.000Z"
}
```

**Notes for all scoped types**

- At least one id is required; up to 500 per sale; duplicates are rejected.
- Every id must exist — a typo is a `400`.
- Ids are validated against the table matching the scope, so a category id sent
  with `scopeType: DEALERS` is rejected.
- New scope kinds can be added later without breaking this contract. Treat
  `scopeType` as an **open enum**: render an unknown value gracefully rather than
  crashing.

---

## Frontend behaviour

> ### The app must never calculate discounts itself.
>
> Not "should not" — **must not**. Any percentage arithmetic in client code is a
> bug, even if it looks correct today.

**Why this is a hard rule:**

- Choosing the winning sale requires the campaign set, scope targets, priorities
  and creation timestamps. The public endpoint deliberately exposes none of that.
- The rounding rule is exact and specific: the **discount** is rounded to the
  nearest so'm, not the final price, so `originalPrice - discountAmount ===
  finalPrice` holds precisely and cart totals never drift from the sum of their
  lines. Client-side rounding will disagree by 1 so'm and produce totals that do
  not add up.
- Campaigns change while the app is open. A cached client-side rule silently
  prices things wrong.
- If the app and the server disagree about a price, the user sees one number and
  is charged another.

### What to render

Once price integration lands (see below), a priced product will carry both the
original and the final price plus the applied campaign. Render it like this:

| Element | Source | Rule |
|---|---|---|
| Original price | `originalPrice` | Show struck-through **only when** a discount applied. |
| Discounted price | `finalPrice` | The prominent number. **Always** what the user pays. |
| Discount badge | `discountPercent` | e.g. `−15%`. Display only. |
| Saved amount | `discountAmount` | Optional, e.g. "You save 15 000 so'm". |
| Campaign name | `appliedSale.title` | Optional badge, e.g. "Summer brake sale". |

**When no sale applies**, the response still contains a complete result:
`finalPrice === originalPrice`, `discountAmount: 0`, `discountPercent: 0`,
`appliedSale: null`. Render the plain price with no strike-through and no badge.

**Use `appliedSale === null` as the "is discounted?" test** — not
`finalPrice < originalPrice`, and never a locally computed comparison.

### Rendering the campaign feed

`GET /v1/sales` is for banners and campaign pages. Since it exposes no target ids,
you cannot mark individual products as "on sale" from it. Product-level discount
state comes with the product data, not from this list.

---

## Future integration

**Current state:** `DiscountService` exists, is unit-tested, and is exported from
`SalesModule` for other modules to inject. It is **not yet called** by the product,
cart or order endpoints, so no price today reflects a sale, and `Order.discountUzs`
is still populated exclusively by promo codes.

When integration lands, each priced item will carry a discount result shaped like:

```json
{
  "originalPrice": 100000,
  "finalPrice": 85000,
  "discountAmount": 15000,
  "discountPercent": 15,
  "appliedSale": {
    "id": "sale_01HXC3KF8Q2M4N6P8R0T2V4X6Z",
    "title": "Summer brake sale",
    "discountType": "PERCENT",
    "discountValue": 15
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `originalPrice` | `number` | Undiscounted price, whole UZS. |
| `finalPrice` | `number` | What the user pays. Never negative; never above `originalPrice`. |
| `discountAmount` | `number` | Exactly `originalPrice - finalPrice`. |
| `discountPercent` | `number` | Effective percentage achieved, ≤ 2 decimals. Display only. |
| `appliedSale` | object `\| null` | The winning campaign, or `null` if none applied. |

**Guarantees you can rely on:**

- `originalPrice - discountAmount === finalPrice`, exactly, in integers.
- `finalPrice >= 0` — a fixed discount larger than the price yields a free item,
  never a negative one.
- `appliedSale: null` ⟺ `discountAmount === 0`.

**Consumption per surface:**

- **Products** — list and detail responses gain the discount result per product.
  Render from it directly.
- **Cart** — each line carries its own result. Line totals and the cart subtotal
  come from the server; do not re-add them client-side. Promo-code discount stays a
  separate, cart-level field and is unaffected by sales.
- **Orders** — at checkout the discounted price is **snapshotted** onto the order
  line. Order items store their own price and hold **no reference to a sale**, so a
  campaign that later ends, is edited, or is deleted can never alter a past order's
  totals. Historical orders are permanently safe.

**The backend is the single source of truth for every price.** The app's job is to
display what it receives. If a number looks wrong, it is a backend bug to report —
not something to correct client-side.

---

## FAQ

**Why doesn't the app calculate discounts?**
Because it structurally cannot do so correctly. Picking the winning campaign needs
the full campaign set, their scope targets, priorities and creation timestamps —
none of which the public API exposes. Add the exact rounding rule and the fact that
campaigns change while the app is open, and any client-side calculation will
eventually disagree with the server. When it does, the user sees one price and is
charged another.

**Why isn't a promo code the same as a Sale?**
They are different mechanisms that happen to both reduce a price. A promo code is
typed by the user and discounts the **cart**; a sale is created by an operator,
applies automatically, and discounts a **product**. They share no storage and no
code path, and they do not interact: applying a promo code does not change which
sale is selected, and a sale does not consume a promo code.

**Why is only one Sale applied?**
Stacking is a deliberate product decision — compounding campaigns is how a catalog
accidentally ends up selling below cost. With three overlapping campaigns, the
backend picks exactly one by the rules in [Selection rules](#selection-rules) and
ignores the rest.

**Why can two products receive different discounts?**
Because campaigns are scoped. A `CATEGORIES` sale covers only its categories, a
`DEALERS` sale only its dealers. Two products in one cart may be covered by
different campaigns — or one may be covered and the other not at all. This is
normal; render each line from its own discount result.

**Can the same product get a different discount tomorrow?**
Yes. Campaigns start, end, and can be re-prioritised at any time. Never cache a
price across sessions, and re-read prices when a cart is reopened.

**What happens when a Sale expires?**
It stops applying the instant `endAt` passes, and disappears from `GET /v1/sales`.
No background job is involved: activeness is evaluated from the clock on every
request, so there is no window where an expired campaign is still being applied.
In the admin console it reports `status: "expired"`.

**What happens when a Sale is deleted?**
Deletion is **soft** — the row is stamped with `deletedAt` and kept. The campaign
immediately stops applying and vanishes from both lists, but remains visible via
`GET /v1/admin/sales?status=deleted`. Deletion is terminal: there is no restore, so
confirm destructively in the UI. **Past orders are completely unaffected** —
order lines snapshot their own price and hold no reference to a sale.

**A sale is listed in `GET /v1/sales` but a product still shows full price. Bug?**
Not necessarily. The feed lists campaigns that are *running*, not the products each
one covers. A scoped campaign may simply not cover that product, or a
higher-priority campaign may have won. Product-level truth is the discount result
attached to the product, never the campaign feed.

**Which field tells me an item is discounted?**
`appliedSale !== null`. Do not infer it by comparing prices, and never by
recomputing one.

---

## Related

- Public endpoint: `GET /v1/sales`
- Admin endpoints: `/v1/admin/sales`
- Swagger: `/docs` (tags **Sales** and **Admin Sales**)
- Backend source: `src/sales/`
