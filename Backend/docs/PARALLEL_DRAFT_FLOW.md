# Parallel Draft Flow (photos-first product creation)

**Goal:** hide FLUX image-processing latency (~20–40s/photo) behind the time the
seller spends filling the product questionnaire. Photos are uploaded **first** and
processed in the background (BullMQ) while the seller answers the wizard; the
preview appears only when **both** the form and all images are done.

**Status:** feature-flagged (`PARALLEL_DRAFT_FLOW`). When off, the original
synchronous photos-last flow runs unchanged. The two flows share the questionnaire
FSM verbatim; only the entry point and post-PRICE behaviour differ.

---

## 1. Architecture at a glance

```
Telegram (Telegraf, long-poll)                     BullMQ image worker (concurrency N)
─────────────────────────────                      ───────────────────────────────────
/start → upload photos FIRST                        process(job {draftId, imageId}):
  create ProductDraft (+ 1 image row/photo)           A. INGEST  (if no original yet):
  enqueue 1 job per image  ───────────────────►          getFileLink → download → Cloudinary
  ask BRAND…PRICE (questionnaire)                          (store ORIGINAL) [only Telegram touch]
  each answer → persist to draft                        B. ENHANCE:
  onFormStep → rendezvous                                  download original → FLUX → Cloudinary
                        │                                   (store PROCESSED) → row READY
                        │                                 onImageSettled → rendezvous
                        ▼                                         │
              DraftCoordinator.maybeAdvanceToPreview  ◄──────────┘
              (reads BOTH axes; versioned CREATING→READY_FOR_PREVIEW)
                        │ emits domain event (EventEmitter2, in-process)
                        ▼
              TelegramService @OnEvent → sendPreview / failure notice
```

**Separation of concerns (deliberate):**

| Component | File | Responsibility |
|---|---|---|
| `product-wizard.ts` | pure FSM | Questionnaire steps + the photos-first entry states. No I/O. |
| `ProductDraftService` | `product-draft.service.ts` | **Thin data layer**: draft/image CRUD + the versioned `tryTransition`. No rules, no events. |
| `DraftCoordinator` | `draft-coordinator.ts` | **Rendezvous** (`onFormStep`/`onImageSettled`/`maybeAdvanceToPreview`) + emits domain events. |
| `ImageProcessingProcessor` | `queue.processors.ts` | The two-phase image worker. Telegram only for **download**; never messages sellers. |
| `TelegramFileService` | `telegram-file.service.ts` | `file_id → download URL` (standalone Telegram client, not the polling bot). |
| `TelegramService` | `telegram.service.ts` | Orchestration (photos-first, resume, retry, cancel) + `@OnEvent` listeners. |
| `DraftCleanupProcessor` | `draft-cleanup.processor.ts` | Hourly TTL sweep of abandoned/orphaned drafts. |
| `DraftTelemetry` | `draft-telemetry.ts` | The one place structured logs + metric points are emitted. |

The worker never depends on `TelegramService` (no Queue↔Telegram cycle):
notifications flow **out** via domain events; the source image is fetched via
`TelegramFileService` (download only).

---

## 2. Draft model & state (two independent axes)

```prisma
ProductDraft   { id, sellerId, tgId, status, version, formStep, <form fields>, expiresAt, images[] }
ProductDraftImage { id, draftId, sortOrder, status, stage, tgFileId,
                    originalUrl/originalPublicId, processedUrl/processedPublicId, jobId, attempts }
```

- **`Draft.status` (form axis):** `CREATING → READY_FOR_PREVIEW → PUBLISHED`
  (+ `CANCELLED` / `EXPIRED`). Every transition goes through the **optimistic lock**
  (`version`): `UPDATE … WHERE id=? AND status=? AND version=?`.
- **`DraftImage.status` (user axis):** `PROCESSING → READY | FAILED`. **The
  rendezvous reads only this.**
- **`DraftImage.stage` (technical axis, observability only):**
  `QUEUED → INGESTING_ORIGINAL → ENHANCING → UPLOADING_RESULT → DONE | FAILED`.
  Invariant kept by the worker: `DONE⇔READY`, `FAILED⇔FAILED`, any intermediate
  `stage ⇒ PROCESSING`. Never gates business logic; retry keys off `originalUrl`.

**Rendezvous rule** (`DraftCoordinator`): flip `CREATING → READY_FOR_PREVIEW` iff
`formComplete` (title, brand, model, category, price all set) **and** every image
row is `READY`. Any `FAILED` image at the batch boundary emits `images_failed`
instead (draft stays `CREATING`). The versioned transition guarantees the preview
is emitted **exactly once** even when the form thread and the last image worker race.

---

## 3. Worker flow (two-phase, phase-idempotent)

```
process(job {draftId, imageId}):
  markImageProcessing (status=PROCESSING, attempts++)
  A. INGEST — only if originalUrl is not set yet:
       stage=INGESTING_ORIGINAL
       getFileLink(tgFileId) → download → Cloudinary.upload  → store originalUrl/publicId
     (the ONLY Telegram call, and it's a download; skipped on any retry once stored)
  B. ENHANCE:
       stage=ENHANCING   → download original → FLUX (removeBackground)
       stage=UPLOADING_RESULT → Cloudinary.upload → markImageReady (status=READY, stage=DONE)
  onImageSettled(draftId)   # rendezvous

@OnWorkerEvent('failed'):   # fires on EVERY attempt
  if attemptsMade < maxAttempts: return       # let BullMQ retry
  markImageFailed → onImageSettled            # only after the last retry
```

Each phase is idempotent, so BullMQ retries are safe. Because the retry decision
keys off the stored `originalUrl` (data), a re-run skips phase A and never re-hits
Telegram — the short-lived `file_id` is only needed for the very first pickup.

**Concurrency:** the worker runs `IMAGE_CONCURRENCY` jobs in parallel (default 5,
range 1–10). This is what makes an album's photos process concurrently. It MUST be
supplied via the `@Processor` decorator's worker options (see the note in
`queue.processors.ts`): `@nestjs/bullmq@11` reads worker concurrency only from
`@Processor` metadata, evaluated at class-load time — hence `process.env`, not
`ConfigService`.

---

## 4. BullMQ / queue flow

- Queue: `image-processing`. **Deterministic jobId** `image:<draftId>:<imageId>` →
  a duplicate `add()` collapses (idempotent enqueue).
- Retry policy (`DEFAULT_JOB_OPTIONS`): `attempts` = `IMAGE_QUEUE_RETRIES` (default
  3), exponential backoff base = `IMAGE_QUEUE_BACKOFF_MS` (default 2000).
- Retention: successes kept 24h/1000; failures kept 7d/5000 (so they can be
  inspected/retried).
- **Retry gotcha (important):** a FAILED job is retained, so its jobId still EXISTS
  in Redis. A plain `enqueueImage()` with that id would be treated as a duplicate
  and do **nothing**. All retry/recovery paths therefore use
  `QueueService.reenqueueImage()`, which **removes the stale job first**, then adds.

---

## 5. Telegram conversation flow

```
/start (ACTIVE seller):
  READY_FOR_PREVIEW draft exists?  → re-present its preview (lost-preview recovery)
  else CREATING draft within TTL?  → [▶️ Продолжить] [🆕 Начать заново]
  else                             → "Сначала отправьте фотографии…" (PHOTOS_FIRST)

photos received → create draft + enqueue jobs (NO network in this path) →
  "✅ Фото получены… заполните информацию" → BRAND…PRICE (questionnaire)

on PRICE (form done):
  images all READY  → preview (Добавить/Назад/Изменить фото)
  images running    → "⏳ Завершаем обработку фото…"  (worker completion triggers preview)
  some FAILED       → "⚠️ …" [🔁 Повторить] [❌ Отмена]

on last image READY (form already done) → preview sent out-of-band (via @OnEvent)

Preview → Добавить → publish product (legacy commitPending) + mark draft PUBLISHED
```

`@OnEvent` handlers on `TelegramService`:
`draft.ready_for_preview` → `presentDraftPreview` (builds the pending confirmation
from the draft and sends the preview, reusing the existing confirm/cancel/back
machinery); `draft.images_failed` → retry/cancel buttons.

---

## 6. Resume (/start on an in-progress draft)

`ProductDraft` is durable "saved progress". On `/start`:

1. **Lost preview:** a `READY_FOR_PREVIEW` draft within TTL is **re-presented**
   directly (recovers a preview whose delivery was lost to a crash).
2. **Continue/restart:** any `CREATING` draft within TTL offers
   Продолжить / Начать заново. Continue restores the wizard session at the saved
   `formStep`, **re-enqueues any stuck `PROCESSING` rows** (heals a crash in the
   original enqueue loop), and — if some images failed — offers retry.
3. Drafts older than TTL are never offered; the sweep expires them.

---

## 7. Cleanup / TTL

Hourly BullMQ **repeatable** job (`draft-cleanup` on the `maintenance` queue):

```
for each draft where status ∈ {CREATING, READY_FOR_PREVIEW} AND expiresAt < now:
    delete Cloudinary assets (originals + processed)
    remove any unfinished image jobs (by deterministic id)
    tryTransition(currentStatus → EXPIRED)   # versioned; skips a draft that advanced
```

TTL = `DRAFT_TTL_HOURS` (default 24, range 1–168). `READY_FOR_PREVIEW` is included
so a preview the seller never confirmed doesn't orphan its assets forever.
**Published drafts are never swept** — on confirm the draft is transitioned to
`PUBLISHED` and its intermediate **originals** are deleted (the processed assets
belong to the live product and are kept).

---

## 8. Failure & recovery matrix

| Event | Behaviour |
|---|---|
| Image job fails (transient) | BullMQ retries (`IMAGE_QUEUE_RETRIES`, exp backoff). |
| Image job fails (final) | Row `FAILED` → `images_failed` → seller gets 🔁/❌. Form data kept. |
| Retry (🔁) | `reenqueueImage` (removes stale failed job) re-runs only failed rows; resumes at phase B if the original was already stored. |
| Backend restart (graceful) | `enableShutdownHooks` → worker drains active job before exit. In-flight jobs resume from Redis. |
| Backend crash (hard) | BullMQ stalled-job recovery re-runs the interrupted job; phase-idempotency handles partial work. |
| Redis restart | Jobs persist in Redis; worker reconnects and continues. Draft state is in Postgres, unaffected. |
| Crash after Cloudinary original, before READY | Retry/resume re-runs phase B only (original reused). |
| Crash after FLUX, before DB READY | Retry re-runs phase B (a duplicate processed upload may occur; harmless, superseded). |
| Crash after READY, before preview sent | `/start` re-presents the `READY_FOR_PREVIEW` draft; sweep is the backstop. |
| Enqueue-loop crash (some rows never queued) | `/start` resume re-enqueues stuck `PROCESSING` rows; sweep is the backstop. |

**Orphan closure:** originals & processed assets, image rows, and jobs are all
owned by a draft; a draft always ends `PUBLISHED` (originals cleaned) or
`CANCELLED`/`EXPIRED` (all assets + jobs cleaned). The only transient orphan window
(assets created, draft not yet terminal) is bounded by the TTL sweep.

---

## 9. Configuration (all env, no magic numbers)

| Var | Default | Range | Meaning |
|---|---|---|---|
| `PARALLEL_DRAFT_FLOW` | `false` | `true`/`false` | Enable the photos-first flow. Off = legacy flow. |
| `IMAGE_CONCURRENCY` | `5` | 1–10 | Parallel image jobs per worker (also the legacy album pool bound). |
| `DRAFT_TTL_HOURS` | `24` | 1–168 | Draft lifetime = resume window = sweep horizon. |
| `IMAGE_QUEUE_RETRIES` | `3` | ≥1 | BullMQ `attempts` (queue-wide default). |
| `IMAGE_QUEUE_BACKOFF_MS` | `2000` | ≥1 | Exponential backoff base (queue-wide default). |

Invalid values fall back to the default (logged as a warning, except when unset).

---

## 10. Observability

`DraftTelemetry` emits, via the Nest `Logger`, both a **structured event** (`event=…`
under logger `DraftFlow`) and a **metric point** (`metric=…` under `DraftMetrics`).
Each carries only ids: `draftId`, `imageId`, `sellerId`, `jobId` — no bytes, URLs,
tokens, or PII.

Events: `draft.created`, `image.queued`, `image.original_stored`,
`image.flux_started`, `image.flux_finished`, `image.processed_uploaded`,
`image.ready`, `draft.preview_ready`, `draft.published`, `draft.expired`.

Metrics (counter-style, ready to swap for a real backend — change only
`DraftTelemetry`): `draft.created`, `draft.expired`, `draft.published`,
`draft.preview.emitted`, `image.processing.queued|started|completed|failed`.

---

## 11. Rollback

The flow is **flag-gated and additive**:

- `PARALLEL_DRAFT_FLOW=false` (default) → legacy synchronous flow, untouched. Zero
  behaviour change until the flag is flipped.
- The new tables/columns are additive; the legacy path never reads them.
- To roll back after enabling: set the flag off. In-flight drafts finish or are
  swept by TTL; nothing legacy depends on them.

**Cutover (future Phase 3, not done here):** default the flag on, delete the legacy
inline `processImages` / in-memory pending TTL, drop the flag. Until then both
flows coexist.
