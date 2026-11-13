# Garage ↔ Vehicle Image Pipeline (Phase 3E)

The pipeline contract comes from MatorUI- `services/vehicle-image-pipeline.mjs` at commit
`567bdfc0ae89ead383f23b6a0731b1de09e61f08`. That file is identical on MatorUI- `main`.
Code lives in `src/garage/vehicle-images/`.

## Schema migration

`prisma/migrations/20261113000000_vehicle_image_integration` is additive only:

- `vehicles.image_identity_key` CHAR(64) NULL (FK, ON DELETE SET NULL) and
  `vehicles.image_review_reason` VARCHAR(64) NULL, each with an index.
- `vehicle_image_identities`: one row per canonical identity, holding the pipeline state
  that Garage responses read.
- `vehicle_image_outbox`: the transactional outbox, with a hand-written partial unique
  index (one PENDING row per identity).
- Enums `VehicleImageStatus`, `VehicleImageOutboxStatus`.

Apply the migration **before** deploying the code. The new code reads the new columns on
every Garage read. The old code ignores them, and nothing existing is changed.
Existing vehicles show `vehicle_image: {status: "unavailable", reason: "not_requested"}`.

Later additive migrations, in order: `20261115000000_vehicle_model_variants` (generation
rows), `20261116000000_vehicle_image_catalog_key`, `20261117000000_nexia_generation_catalog_rows`
and `20261118000000_vehicle_identity_snapshot` (four NULLABLE `vehicles.identity_*` columns:
model, generation, facelift, market). Each goes before the code that reads it.

## Configuration (server-only)

| Variable | Meaning |
|---|---|
| `VEHICLE_IMAGES_ENABLED` | `true` lets the Garage send identities WITHOUT an approved registry image to the pipeline. Default off: no pipeline calls. Identity resolution and approved registry images work either way. |
| `VEHICLE_IMAGE_PIPELINE_URL` | https base URL, or http to loopback (`http://127.0.0.1:8047`). |
| `VEHICLE_IMAGE_REQUEST_TOKEN` | The pipeline's `VEHICLE_IMAGE_REQUEST_TOKEN` (≥32 chars). Never the admin token. |
| `VEHICLE_IMAGE_REQUEST_TIMEOUT_MS` | Queue call timeout, 1000–60000 (default 10000). |
| `VEHICLE_IMAGE_MARKET_REGION` | Retired and ignored (a leftover value does not stop boot). The market is resolved per vehicle; there is no global default. |

Boot refuses an enabled but incomplete configuration. **Enabling it against a pipeline
that has a provider key requests generation, which may be paid, for every new identity.**

## Identity

The tuple is `['mator-vehicle-image-v1', makeId, modelId, modelYear, generationId,
faceliftId, bodyType, trimId]`, and the key is the SHA-256 hex of its `JSON.stringify`.
Golden vectors from the real pipeline are pinned in `vehicle-image.identity.spec.ts`.

- `makeId`/`modelYear` come from the Garage record. `modelId` is the catalog row the
  vehicle is pictured as: its own model, or the generation row its year (or the owner's
  pick) resolves a generic model to (`nexia` 2018 → `nexia-3`). `bodyType` comes from
  that row's `body_type`, when set. `trimId` is the catalog trim the owner picked.
- `marketRegion` (8-field `mator-vehicle-image-v2` tuple) is the vehicle's own verified
  market (below). Without one there is no request at all.
- The tuple's `generationId` and `faceliftId` stay `null`, so existing identity keys do not
  change. The verified generation and facelift ids are saved on the vehicle instead.
- Display facts sent: `vehicle_makes.name`, `vehicle_models.name`, `vehicle_trims.name`
  when a trim was picked, and the market.

### Year

The Garage `year` is the build (production) year, "год выпуска": the catalog's
`year_from`/`year_to` and the registry's year ranges are build years too. A model year
(VIN position 10) is never inferred, and a registration year is not collected.
`POST /v1/garage/vehicles` refuses a year outside the model's stated range, outside every
verified generation of a generic model, or later than next year (Tashkent time) with
`400 {code: "VEHICLE_YEAR_UNSUPPORTED", message, details: {year, year_from, year_to}}`.
A model with no stated range accepts any year up to next year.

### Market, generation, facelift: the vehicle image registry

`src/garage/vehicle-images/vehicle-image-catalog.data.ts` is MatorUI-
`services/vehicle-image-catalog.json`, byte for byte (commit and sha256 in the file and
pinned in its spec); `vehicle-image.catalog.ts` ports the pipeline's matching rules.

- Market/generation/facelift come only from entries with `identityVerified: true` and a
  `marketRegion`, through a model mapping covering the pictured model and year. On
  2026-11-13 that is: Cobalt 2013–2026, Gentra 2013–2026, Lacetti 2020–2026 (the Gentra
  body), Nexia 2 2009–2016, Nexia 3 2016–2022 (and `nexia` trimmed `nexia-3-*`), all `UZ`.
  Nothing else has a verified market, so nothing else is ever requested.
- The approved image: an approved, identity-verified entry of the same make and market
  whose first mapping covers the vehicle (exact), else one whose later mapping does
  (verified compatible). Today: `cobalt-gen2`, `gentra`, `nexia-r3`.
- To take a new registry version: paste the upstream file in full into the data module,
  update its commit/hash comment and the hash in `vehicle-image.catalog.spec.ts`, and deploy
  the backend and the pipeline together.

### Review instead of request

The vehicle is kept (make, model, year), stays on the placeholder, gets
`image_review_reason`, and nothing is sent to the pipeline:

  - `duplicate_model_name`: another model of the same make has the same name, e.g.
    `tracker` / `tracker-2`.
  - `year_outside_model_range`: the year falls outside the catalog's `year_from`/`year_to`
    (create refuses such a year first; kept for older rows).
  - `generation_unresolved`: a generic model's year matches several generations (and no
    pick yet) or none.
  - `market_unverified`: no verified registry entry covers the vehicle (Spark, Tracker,
    Malibu, every VW, …).
  - `catalog_ambiguous`: verified entries disagree, or two approved images answer equally.
  - `catalog_image_rejected`: the covering registry image was rejected.
  - `identity_invalid`: catalog rows fail the pipeline contract.

  List flagged vehicles with
  `SELECT id, make_id, model_id, year, image_review_reason FROM vehicles WHERE image_review_reason IS NOT NULL;`

## Flow

1. `POST /v1/garage/vehicles` writes the identity snapshot on the vehicle and the identity
   row inside the vehicle's own transaction, whether or not the integration is on. Image
   priority: (1) the exact approved registry image, (2) a verified compatible one, both
   saved at once as `approved` with `catalog_asset_key` (no pipeline call, never synced);
   (3) an approved pipeline publication already on the identity; (4) the placeholder.
   Only for (4), and only while the integration is on, one outbox row is written; after
   commit `dispatch` is enqueued on the `vehicle-images` queue (fire-and-forget, so Redis
   being down does not affect the response). While it is off the identity is saved as
   `unavailable / not_requested`, and the first new vehicle after it is switched on asks.
2. `dispatch` claims one attempt (jobId `<outboxId>-a<attempt>`) and calls
   `POST /internal/v1/vehicle-images/requests`.
   - Transient failures (network, timeout, 5xx, 429, 401/403/404) retry with backoff
     30 s · 2^(n-1), up to 15 min, for at most 8 attempts.
   - Permanent failures (400/413/415/422, or a contract or identity-key mismatch) and an
     exhausted retry budget mark the row DEAD and the identity
     `unavailable / request_failed`.
3. `relay` (every 30 s) re-enqueues due outbox rows: lost enqueues, retries and expired
   leases.
4. `sync` (every 60 s) calls `POST /internal/v1/vehicle-images/resolve` for due
   identities. It re-checks queued/running after 2 min, awaiting_approval after 15 min,
   failed/rejected after 1 h and approved after 6 h. It stops the batch on an outage.
5. `GET /v1/garage/vehicles/:id/image` resolves the identity on demand. It does this only
   once the pipeline has acknowledged the request, at most every 15 s per identity, with
   a 3 s timeout. On failure it returns the stored state.

The relay and sync schedulers exist only while the integration is enabled.

A new vehicle with an already known identity never triggers a new request when that
identity is approved, failed or rejected. It is re-requested only when the earlier
request never reached the pipeline. Failed AI jobs are never regenerated automatically.
Only the pipeline administrator regenerates them.

## Response field

`vehicle_image` and `identity` appear on create, list, get and in `vehicle.created`
realtime payloads (`GET /:id/image` returns `vehicle_image` only):

```json
"identity": { "status": "verified" | "needs_review" | "unresolved",
  "reason": null | "<review reason above>",
  "model_id": "nexia-3" | null, "generation_id": "nexia-3" | null,
  "facelift_id": null, "market": "UZ" | null, "year_basis": "production" }
```

`identity` is the saved snapshot, never recomputed on read: a later catalog edit does not
reassign a saved vehicle. `unresolved` = added before identities were resolved.


```json
{ "status": "pending" | "approved" | "unavailable",
  "url": "https://…" | null, "version": 1 | null,
  "reason": null | "not_requested" | "needs_review" | "generation_failed" | "rejected" | "request_failed" }
```

`approved` carries either `catalog_asset_key` (a registry image the app bundles; shown only
while the registry still approves that key, otherwise `unavailable / needs_review`) or a
public https `url`. A pipeline publication is shown only for a market-aware identity; one
saved for a market-less (legacy) identity is reported as `unavailable / not_requested`, so
the app keeps its own owner-approved image or the placeholder (never, e.g., a US-market
Spark). A pipeline without Cloudinary returns `/published/…`, which stays `pending` and
exposes no URL. `GET /:id/image` returns `{ vehicle_id, vehicle_image }`.
