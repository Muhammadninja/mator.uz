# Garage vehicle images: lifecycle, deployment and rollback

Status: deployed 2026-11-14. Production backend `main` (PR #146) talks to its own pipeline `mator-vehicle-images` on 8047 (contract 2, registry `9ecf78141f3e…`). Staging runs the same pipeline release on 8048. Publication is still off until the Cloudinary settings are added to the pipeline environment (see "Publication storage").

Three repositories change together:

| Repository | Branch | What |
| --- | --- | --- |
| Backend (`mator.uz`) | `feat/vehicle-image-lifecycle` | identity resolution, pipeline client, recovery, reconcile, admin API, migration `20261119000000` |
| Pipeline + app (`MatorUI-`) | `feat/vehicle-image-lifecycle` | reviewed acquisition, registry hints, Garage framing, local store, app states and refresh |
| Admin (`mator-admin`) | `feat/vehicle-image-review` | «Изображения авто» review page |

## How an image reaches a Garage vehicle

1. **Add.** The backend saves the vehicle at once and resolves its identity from catalog rows and the registry (`services/vehicle-image-catalog.json`):
   - *verified*: the registry verifies market and generation (Cobalt 2013–2026, Gentra, Lacetti 2020+, Nexia 2, Nexia 3);
   - *unverified*: a valid catalog vehicle the registry says nothing about (Spark, Malibu, Captiva, a new make such as Toyota Camry). No market or generation is guessed;
   - *needs review*: the catalog contradicts itself, or the owner must pick a generation (Nexia 2016).
2. **Existing image first.** An approved registry image is shown at once. Otherwise one outbox row per identity goes to the pipeline (50 owners of the same car produce one request).
3. **Acquisition.** The pipeline shares one *subject* per verified registry entry (all Nexia 2 years 2009–2016) or per approved year scope. For each subject it tries free repository artwork that the registry links to the vehicle, then paid generation only where it is enabled and allowed. Nothing is published by itself: every candidate is private.
4. **Review.** In «Изображения авто» a manager approves or rejects candidates, uploads a transparent PNG/WebP where there is none, or retries. An unverified identity is published only with the reviewer's confirmation and a note of what they checked. An optional year scope lets one approval serve later owners of other years. A rejected picture is never proposed again for that subject. Every decision is in `admin_audits`.
5. **Publication.** The approved image is normalised to the Garage framing (1200×600 transparent WebP, car at 81% width, tyres on the bottom edge), stored as a new immutable version (Cloudinary in production) and synced to every vehicle that shows it. The app picks it up on its next read, in the foreground, or through the pending-image poll.

## Root cause of the production `network` errors (to confirm on the server)

Since 2026-11-14 the production backend has run with `VEHICLE_IMAGES_ENABLED=true`, and every minute its sync fails with `network`. The only image pipeline on the VPS is `mator-vehicle-images-staging` (pm2 2, loopback port **8048**, its own staging tokens). The staging documentation forbids pointing production at it, and no production pipeline (`mator-vehicle-images`, port **8047**) is running. The most likely cause is therefore that production's `VEHICLE_IMAGE_PIPELINE_URL` points at a port where nothing listens (`ECONNREFUSED`). The old client reported every transport failure as plain `network`, so the cause never showed.

Confirm it with the read-only diagnosis, run on the VPS from the production backend directory:

```sh
cd /root/mator.uz/Backend
node scripts/vehicle-images/diagnose-pipeline.mjs --env .env
```

The script prints every check (settings, DNS, TCP, redirects, TLS, readiness, registry fingerprint, and one authenticated read-only `resolve`). For each failure it also prints the fix. It never prints a token and never writes. From this release on, the backend also records the precise code per identity (`network:ECONNREFUSED`, `registry_mismatch`, …), and `GET /v1/admin/vehicle-images/status` shows it.

## Deployment order (owner-run)

1. **Back up.** Take a PostgreSQL custom-format backup. Then stop the pipeline you will upgrade and archive its data directory (`metadata.json` plus `private/`). Pipeline rollback needs this archive: an older pipeline cannot load the new unverified identities.
2. **Production pipeline** (MatorUI- branch): install a separate production pipeline, never the staging one.
   - Process: `mator-vehicle-images`, port 8047, user `mator-vehicle-images-prod`, code in `/opt/mator/vehicle-image-pipeline-production`, environment `/etc/mator/vehicle-images-production.env` (mode 0600, owned by that user; the user needs `--x` on `/etc/mator`, e.g. `setfacl -m u:mator-vehicle-images-prod:--x /etc/mator`).
   - Tokens: its own admin and request tokens.
   - `VEHICLE_IMAGE_DATA_DIR=/var/lib/mator-vehicle-images-production`.
   - `VEHICLE_IMAGE_REGISTRY_SHA256` = the backend's `VEHICLE_IMAGE_CATALOG_SHA256` (`src/garage/vehicle-images/vehicle-image-catalog.data.ts`). Unset, malformed or different: `/health/ready` answers 503 (`registry_unconfigured`, `registry_invalid`, `registry_mismatch`) and the internal routes answer 503, so a pipeline with the wrong registry never reports ready.
   - `VEHICLE_IMAGE_REPOSITORY_ARTWORK_ENABLED=true`. The checkout must contain `assets/vehicles/`.
   - `VEHICLE_IMAGE_GENERATION_ENABLED=false` and `VEHICLE_IMAGE_ALLOW_UNVERIFIED_GENERATION=false`.
   - Publication: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (the parts account, see below) and `VEHICLE_IMAGE_PUBLICATION_ENABLED=true`. Images go to the folder `mator/vehicle-images/`. With `VEHICLE_IMAGE_PUBLICATION_ENABLED=false` everything else works, but approvals answer 503.
   - Check: `curl -s http://127.0.0.1:8047/health/ready` must answer 200 with `"contract":2` and `"registry":{…"sha256":"9ecf78141f3e…","check":"ok"}`.
3. **Migration**, after `20261118000000_vehicle_identity_snapshot` (which is also still pending in production): `npx prisma migrate deploy`. It is additive: new columns, a log table and new enum values. Deploy it before the code.
4. **Backend** (the backend branch). Set in `.env`:
   - `VEHICLE_IMAGE_PIPELINE_URL=http://127.0.0.1:8047`, the production pipeline;
   - `VEHICLE_IMAGE_REQUEST_TOKEN`, equal to the pipeline's request token;
   - `VEHICLE_IMAGE_ADMIN_TOKEN`, equal to the pipeline's admin token and different from the request token;
   - `VEHICLE_IMAGE_RECONCILE_ENABLED=false` for now.

   Restart pm2 1. The boot log says "pipeline ready; registry fingerprints match" or names the failure. Then run the diagnosis again; it must exit 0.
5. **Saved vehicles.** Run `npm run vehicle-images:reconcile` (a dry run that writes nothing) and read the report. Then either run it with `-- --apply`, or set `VEHICLE_IMAGE_RECONCILE_ENABLED=true` and restart. The job then runs every 15 minutes, once per registry version.
6. **Admin console** (the mator-admin branch): deploy as usual. Open «Изображения авто»: every line under the status cards must be resolved or expected.
7. **App** (MatorUI- branch): the changes are JavaScript only (states, refresh, picture guard). Ship them with the next build, or over the air if the build's runtime version matches. Older app builds keep working with the new backend.

### After-deploy checks

- `GET /v1/admin/vehicle-images/status`: `pipelineHealth.ready=true`, `registry.matches=true`, `lastErrors` empty.
- With a test account, add a 2020 Cobalt (approved image at once) and a Spark. The Spark's image is `pending` / `awaiting_review`, and the Spark candidate appears in the console.
- `vehicle_image_outbox` has no growing `PENDING` backlog. Rows marked `DEAD` before the fix are asked again automatically after 30 minutes, once the pipeline is ready.

## Rollback

| Component | How | Notes |
| --- | --- | --- |
| Backend code | Redeploy the previous commit | Leave the migration: it is additive, and the old code ignores the new columns. Turn the reconcile flag off. |
| Reconcile run | `npm run vehicle-images:reconcile -- --revert <runId>`, then the same with `--apply` | Restores previous identities on vehicles not changed since; the run id is in the job log and the audit trail. |
| Pipeline | Stop it, restore the data archive from step 1, start the previous commit | Without the archive, the old pipeline refuses to start on new unverified requests. Published Cloudinary images stay; never delete them. |
| Admin console | Redeploy the previous build | Read-only for data; decisions already made stay audited. |
| App | Previous build or OTA | The backend keeps serving the older contract fields. |

An older backend with the new pipeline gets nothing: the internal routes require `x-mator-vehicle-image-contract: 2` (checked after the Bearer token), and a missing, malformed or unsupported version answers **428** with `supportedContracts`. The backend treats 428 as retryable, so no vehicle is marked failed, but no image state is applied until that backend is upgraded. A new backend with an older pipeline refuses its answers (`pipeline_outdated`, retryable) and applies nothing. So deploy the pipeline and the backend together, pipeline first.

## Decisions that need the owner

- **Publication storage.** Decided 2026-11-15: the production pipeline uses the same Cloudinary account as part photos (credentials already in the backend `.env`), uploading under `mator/vehicle-images/`.
- **Approving the existing artwork.** The console proposes it, and approval stays a person's decision:
  - Nexia 2 (N150, identity verified);
  - Spark M300, Tracker 3, Malibu 2 facelift, Nexia 1, Lacetti J200, Matiz, Orlando, Tahoe, Trailblazer (all unverified).
- **Defective artwork that is never proposed.** It needs a re-export without fake plates or garbled lettering:
  - Malibu 1, Captiva, Onix, Damas and Labo (fake number plates);
  - Epica (fake plate) and Equinox, Traverse (garbled lettering);
  - the file listed as Tracker 2, which shows a Tracker 3.
- **Paid generation.** It stays off. Enabling it is a cost decision: provider, model and daily limit.
