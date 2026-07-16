# Reference Data Gaps

Fields that exist in the **frontend source of truth** but were **not carried into
the backend database** during the Phase 2A reference-data seed.

Why this document exists: in six months nobody will remember why these fields
"disappeared". This is the authoritative record. Nothing was dropped silently —
every gap is listed here with its reason, impact, and decision.

**Ground rule (from Phase 2):** the frontend is the source of truth for reference
data; the backend schema was NOT changed to accommodate these fields. Each gap is
either a deliberate architecture decision (`Do NOT change`) or work deferred to a
later, explicitly-approved phase. None of them block the current
Frontend → Reference API → Garage → Buyer API chain.

Sources:
- `services/uz-vehicle-catalog.ts` (UZ_BRANDS / UZ_MODELS / UZ_GENERATIONS / UZ_TRIMS / UZ_ENGINES)
- `constants/catalog-systems.ts` (CATALOG_SYSTEMS)
- `mocks/mator-catalog.ts` (MATOR_DEALERS)

---

## VehicleModel.bodyStyle

**Reason:**
Backend `VehicleModelRef` has no `bodyStyle` column.

**Impact:**
Body-style grouping / silhouette glyphs in the model picker cannot be sourced
from the backend.

**Decision:**
Deferred.

---

## VehicleModel.order — RESOLVED (Phase 2C)

**Reason (original):**
Backend `VehicleModelRef` had no per-model ordering column.

**Resolution:**
Phase 2C added a `sortOrder` column to `VehicleModelRef` (also `VehicleTrim` and
`VehicleEngine`) and seeds it from the frontend catalog array order. The
Reference API orders by `sortOrder`, reproducing the frontend order exactly.
This was a prerequisite for the "bit-for-bit frontend" requirement, not new
functionality. Migration: `20260716000000_add_reference_sort_order`.

Note: the frontend's richer per-model `order` *field* is still not stored as a
distinct value — the array index is used. In practice they coincide for the
seeded data.

---

## VehicleGeneration (whole entity: yearRange, internalCode, active)

**Reason:**
Backend schema has no `VehicleGeneration` table by design. Year-based fitment is
served by `PartCompatibility.years[]`.

**Impact:**
Generation is not a first-class entity. Its identity is preserved inside the
trim id (e.g. `cobalt-p2-premier`); `yearRange`, `internalCode`, and `active`
are not stored.

**Decision:**
Do NOT change (deliberate architecture decision). Frontend translates
generation → yearRange → year itself.

---

## VehicleTrim.engineIds (trim ↔ engine M:N)

**Reason:**
Backend schema has no M:N relation between trims and engines. The buyer
`Vehicle` row picks one `trimId` + one `engineId`; part fitment lives in
`PartCompatibility`.

**Impact:**
Cannot derive the set of available engines from a trim. A
`GET /v1/reference/engines?trimId=...` endpoint cannot use this link and must
return all engines (or be scoped another way) until this relation exists.

**Decision:**
Deferred.

---

## VehicleEngine.type (na / turbo / hybrid / phev / ev / cng / lpg)

**Reason:**
Backend `VehicleEngine` has no `type` column (only `fuelType` + `displacementCc`).

**Impact:**
Cannot distinguish e.g. NA vs turbo, or PHEV vs hybrid, from the backend.
`fuelType` was derived conservatively from `type` during seeding.

**Decision:**
Deferred.

---

## VehicleEngine.transmissions

**Reason:**
Backend `VehicleEngine` has no `transmissions` column.

**Impact:**
Cannot list an engine's available transmissions from the backend.

**Decision:**
Deferred.

---

## VehicleEngine.oemCatalogScope

**Reason:**
Backend `VehicleEngine` has no `oemCatalogScope` column.

**Impact:**
The OEM-catalogue routing key the frontend forwards for parts search cannot be
sourced from the backend engine row.

**Decision:**
Deferred. Likely needed when OEM-catalogue routing is wired up.

---

## CatalogSystem.labelRu

**Reason:**
Backend `PartCategory` has no `labelRu` column.

**Impact:**
Russian category labels are not available from the backend (categories are
English-only).

**Decision:**
Deferred. This is the "labelRu" Important item from the contract audit.

---

## CatalogSystem.categoryKey

**Reason:**
Backend `PartCategory` has no `categoryKey` column. The parts query keys off
`PartMainCategory` / `PartVehicleCategory` enums or the `PartCategory` id.

**Impact:**
The frontend's `categoryKey` (e.g. `maintenance`) is not stored; category
filtering must use ids/enum values.

**Decision:**
Deferred.

---

## CatalogSystem.iconKey

**Reason:**
Backend `PartCategory` has no `iconKey` column (it has `iconUrl`).

**Impact:**
Icon selection for category tiles cannot be sourced from the backend row.

**Decision:**
Deferred.

---

## MatorDealer.initial / color / orders / years — RESOLVED (Phase 4C)

**Reason (original):**
Backend `CatalogSeller` had no `initial`, `color`, `orders`, or `years` columns.

**Resolution:**
Phase 4C added these four nullable columns to `CatalogSeller` (migration
`20260716010000_add_dealer_storefront_fields`) and seeds them verbatim from the
frontend `MATOR_DEALERS`. The `GET /v1/dealers` endpoint returns the curated
dealers in the frontend MatorDealer shape.

Curated identity is an EXPLICIT flag, not field presence: migration
`20260716020000_add_dealer_is_curated_flag` added `is_curated BOOLEAN NOT NULL
DEFAULT false`; the seed sets it `true` only for d1–d4, and `GET /v1/dealers`
filters on `isCurated = true`. An earlier version filtered on `initial != null`,
which leaked — a projected `seller_<id>` row that acquired a non-empty `initial`
would appear in the dealer list (proven on the test DB). The flag makes
projected rows (default `false`) impossible to leak regardless of which
presentation fields they carry. The storefront columns remain nullable so
projected rows are otherwise unaffected.

---

## Top Featured — REMOVED from the product (historical)

Top Featured (the `FeaturedItem` table, its seed, API, and constants) was a
product concept that has since been removed entirely by a product decision. It
is no longer part of the backend. This entry is kept only to record that the
former "FeaturedItem real values" gap no longer applies — there is nothing to
provide or complete.

---

## Promo banners (SearchPromoBannerItem) — BLOCKED, no data to reproduce (Phase 4D)

**Reason:**
The search page contract (`mocks/search-page-backend-fields.txt`) defines a
`SearchPromoBannerItem` shape — `id, badge, sponsorLabel, title, description,
ctaPrimaryLabel, ctaSecondaryLabel?, imageUrl?, deeplink?, campaignId?,
impressionId?` — served from `GET /search/promo-banners`. But unlike Dealers
(4C), the repo contains **no backend table, no seed data, and
no actual banner content whatsoever**: no data array, no `.data` file, and the
referenced component `components/screens-components/search-promo-banner.tsx` is
not present in this repo. The only artifact is the field spec.

Promo banners are described as a **sponsored/campaign placement** (`sponsorLabel`,
`campaignId`, `impressionId`, rotation of "one active banner or multiple") — a
campaign-managed ad slot, not a static reference table like dealers.

**Impact:**
There is nothing to reproduce bit-for-bit, and the hard rule forbids inventing
banner content (titles, sponsor labels, CTA text, campaign ids). No endpoint is
shipped; the frontend already treats an absent/empty promo section as HIDDEN
(per the same spec's quick-filter/promo-banner notes), so this blocks nothing in
the current chain.

**Decision:**
Phase 4D DEFERRED (user-approved 2026-07-16). To complete, provide the real
promo-banner source (the `search-promo-banner.tsx` data or a campaign list).
When real data exists this becomes a straightforward table + verbatim seed + API
(same pattern as 4C).

---

## Regions (CATALOG_REGIONS, 5 entries) — not seeded at all

**Reason:**
Backend has no `regions` table. Region of origin is a `PartOriginRegion` enum
plus an ingestion-time classifier (`MAKE_REGION` + keywords).

**Impact:**
None for the region filter — parts are tagged with `originRegion` at ingestion.
The frontend's client-side `BRAND_REGION` map is simply no longer needed.

**Decision:**
Do NOT change (deliberate architecture decision).

---

## Quick filters (QUICK_FILTERS_SEED, 5 entries) — not seeded at all

**Reason:**
Backend has no `quick_filters` table. Quick-filter chips are derived live from
inventory (`GET /v1/search/quick-filters`).

**Impact:**
None — the seed list is a frontend fallback; the backend produces the real list
from stock aggregation.

**Decision:**
Do NOT change (deliberate architecture decision, allowed by the contract).

---

## Note: PartOriginRegion.JAPAN

Not a dropped field, recorded for completeness: the backend `PartOriginRegion`
enum has a `JAPAN` member that the frontend `CATALOG_REGIONS` (5 regions) does
not list. This is a backend-only enum extension, not a reference row, and is
left as-is.

---

## Part-level rating / reviews / was_price / specs — no real source (Phase 4E)

**Reason:**
The Phase 4E catalog-improvement scope named five fields: `fits`, `rating`,
`reviews`, `was_price`, `specs`. Only `fits` had a real, existing data source
(the `catalog_part_fits` rows projected from the supply side) and was surfaced
(see below). The other four have **no real source of truth** in the repo:

- `rating` (part-level) and `reviews` — the frontend **synthesizes** these on the
  client from a hash of the id (`services/search-service.ts`:
  `rating = 3.8 + hash%12/10`, `reviewCount = 50 + hash%5000`), explicitly "so the
  mock returns consistent UI values without server data". There is no real
  rating/review store. (Seller-level `rating_avg` DOES exist and is already
  returned under `seller.rating_avg` — that is unaffected.)
- `was_price` (strikethrough / compare-at) and part-level `specs` — appear ONLY in
  `mocks/mator-catalog.ts` `MATOR_PRODUCTS` (p1–p10), which the file header
  declares are "faithful mock fixtures from the Mator design prototype … rather
  than the live car catalog" (Bosch/Denso demo parts, USD prices). These are
  design-prototype demo values, not live marketplace data.

**Impact:**
None for the current chain. The frontend already fabricates rating/reviews
client-side, and was_price/specs render from the prototype fixtures. Backend
carries no invented values.

**Decision:**
Deferred — inventing rating/review/was_price/specs content would violate the
source-of-truth rule. When a real ratings/reviews system or real part specs
exist, add nullable columns (`rating_avg`, `rating_count`, `was_price_uzs`,
`specs` Json) + surface them; that is a straightforward additive change at that
point.

---

## Part `fits[]` — RESOLVED (Phase 4E)

**Reason (original):**
The static make/model fitment for a part already lived in `catalog_part_fits`
(projected from the supply-side PartModel links) and was loaded implicitly, but
the buyer part presenter (`presentPartItem`) dropped it from the response — the
only real fitment gap called out in the contract audit.

**Resolution:**
Phase 4E added `fits: true` to `PART_INCLUDE` and emits a `fits[]` array from
`presentPartItem`, mapping each `CatalogPartFit` row to
`{ make_slug, make_name, model_slug, model_name }`, sorted by `model_slug` for a
stable order. Purely additive surfacing of existing data — no schema change, no
migration, no invented content. Universal parts (no fit rows) get `fits: []`.
Both `GET /v1/catalog/parts` (list) and `GET /v1/catalog/parts/:id` (detail) go
through the same presenter, so both now carry `fits[]`. Unit-tested
(`part.presenter.spec.ts`) and smoke-verified end-to-end on the test DB through
the compiled presenter.
