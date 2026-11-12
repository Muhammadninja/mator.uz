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

## Configuration (server-only)

| Variable | Meaning |
|---|---|
| `VEHICLE_IMAGES_ENABLED` | `true` turns it on. Default off: no writes, no pipeline calls. |
| `VEHICLE_IMAGE_PIPELINE_URL` | https base URL, or http to loopback (`http://127.0.0.1:8047`). |
| `VEHICLE_IMAGE_REQUEST_TOKEN` | The pipeline's `VEHICLE_IMAGE_REQUEST_TOKEN` (≥32 chars). Never the admin token. |
| `VEHICLE_IMAGE_REQUEST_TIMEOUT_MS` | Queue call timeout, 1000–60000 (default 10000). |

Boot refuses an enabled but incomplete configuration. **Enabling it against a pipeline
that has a provider key requests generation, which may be paid, for every new identity.**

## Identity

The tuple is `['mator-vehicle-image-v1', makeId, modelId, modelYear, generationId,
faceliftId, bodyType, trimId]`, and the key is the SHA-256 hex of its `JSON.stringify`.
Golden vectors from the real pipeline are pinned in `vehicle-image.identity.spec.ts`.

- `makeId`/`modelId`/`modelYear` come from the Garage record. `bodyType` comes from
  `vehicle_models.body_type`, when it is set. `trimId` is the catalog trim the owner picked.
- `generationId` and `faceliftId` are always `null`: the catalog has no such tables, and
  nothing derives them.
- Display facts sent: `vehicle_makes.name`, `vehicle_models.name`, and `vehicle_trims.name`
  when a trim was picked.
- Review instead of request (the vehicle keeps the placeholder, and `image_review_reason`
  is set):
  - `duplicate_model_name`: another model of the same make has the same name, e.g.
    `tracker` / `tracker-2`.
  - `year_outside_model_range`: the year falls outside the catalog's `year_from`/`year_to`.
  - `identity_invalid`: catalog rows fail the pipeline contract.

  List flagged vehicles with
  `SELECT id, make_id, model_id, year, image_review_reason FROM vehicles WHERE image_review_reason IS NOT NULL;`

## Flow

1. `POST /v1/garage/vehicles` writes the identity row and, when a request is needed, one
   outbox row, inside the vehicle's own transaction. After commit it enqueues
   `dispatch` on the `vehicle-images` queue. This is fire-and-forget, so Redis being down
   does not affect the response.
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

`vehicle_image` appears on create, list, get and `GET /:id/image`, and in
`vehicle.created` realtime payloads:

```json
{ "status": "pending" | "approved" | "unavailable",
  "url": "https://…" | null, "version": 1 | null,
  "reason": null | "not_requested" | "needs_review" | "generation_failed" | "rejected" | "request_failed" }
```

`url` and `version` are set only for `approved`, and only when the pipeline returns a
public https URL. A pipeline without Cloudinary returns `/published/…`, which stays
`pending` and exposes no URL. `GET /:id/image` returns `{ vehicle_id, vehicle_image }`.
