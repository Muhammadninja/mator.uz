# Draft Flow (photos-first product creation)

**Goal:** hide FLUX image-processing latency (~20–40s/photo) behind the time the
seller spends filling the product questionnaire. Photos are uploaded **first** and
processed in the background (BullMQ) while the seller answers the wizard; the
preview appears only when **both** the form and all images are done.

**Status:** the **only** product-creation path (cut over in Phase 3). There is no
feature flag and no synchronous image pipeline: every image — first upload, retry,
resume, and photo replacement — travels
`Telegram → BullMQ → image worker → DraftCoordinator → preview`.

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

**Wizard FSM (the only path — 10 states, no dead transitions):**

```
PHOTOS_FIRST ──photos accepted (draft created, jobs enqueued)──▶ BRAND
   ▲                                                              │
   │ 🖼 Изменить фото (clone)                                     ▼
   │                                                            MODEL
   │                                                              ▼
   │                                                           CATEGORY
   │                                                              ▼
   │                                                            TITLE
   │                                                              ▼
   │                                                         DESCRIPTION
   │                                                     (text or ⏭ Пропустить)
   │                                                              ▼
   │                                                      PART_NUMBER_TYPE
   │                                                     ╱ OEM/GM      ╲ SKIP
   │                                              PART_NUMBER           │
   │                                                     ╲              ╱
   │                                                        ▼        ▼
   │                        ⬅️ Назад (from preview) ─────▶ PRICE
   │                                                          ▼
   └───────────────────────────────────────────── QUESTIONNAIRE_DONE (terminal)
                                                              │
                                                   coordinator rendezvous → preview
```

`⬅️ Назад` inside the questionnaire walks back one step (`previousStep`), keeping
every entered value. Only `BRAND`, `PHOTOS_FIRST` and `QUESTIONNAIRE_DONE` have no
previous step.

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
instead (draft stays `CREATING`). The versioned transition guarantees the flip
happens **exactly once** even when the form thread and the last image worker race.

**Send-once guarantee** (`previewSentAt`): two candidates can try to *send* the
preview — the worker's `ready_for_preview` event and a `/start` recovery. Before
sending, `presentDraftPreview` does an atomic compare-and-set
(`UPDATE … SET previewSentAt=now WHERE status=READY_FOR_PREVIEW AND previewSentAt IS NULL`);
only the winner (count=1) calls `storePending`+sends. This prevents two
`storePending` runs for one draft — the second would `discardPending` the first and
delete the live preview's Cloudinary assets. `previewSentAt` is delivery metadata,
not a business state; `status` stays `READY_FOR_PREVIEW` (still sweepable/publishable).

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

Preview → ✅ Добавить        → write product (commitPending) + draft PUBLISHED
        → ❌ Отменить        → delete assets + draft CANCELLED
        → ⬅️ Назад           → draft back to CREATING @PRICE (images REUSED)
        → 🖼 Изменить фото   → CLONE draft (form kept) + source CANCELLED → PHOTOS_FIRST
```

`@OnEvent` handlers on `TelegramService`:
`draft.ready_for_preview` → `presentDraftPreview` (builds the pending confirmation
from the draft and sends the preview, reusing the existing confirm/cancel/back
machinery); `draft.images_failed` → retry/cancel buttons.

### Preview edit actions (both draft-backed)

| Button | Draft transition | Images |
|---|---|---|
| **⬅️ Назад** (edit text/price) | `READY_FOR_PREVIEW → CREATING` at `PRICE` (versioned; `previewSentAt` cleared so the next rendezvous may send again) | **Untouched, stay READY** — re-submitting the form re-passes the image axis, so **nothing re-processes** |
| **🖼 Изменить фото** | source `→ CANCELLED`; a **new** `CREATING` draft is cloned with every answered field, at `PHOTOS_FIRST` (one transaction) | source's assets + leftover jobs deleted; the new photos go through the **normal queue path** |

Photo replacement is a **clone, not a mutation**: the source draft owns READY
images, Cloudinary assets and possibly in-flight jobs, so clearing and reusing it
would race the worker and the coordinator. Cloning makes the old draft terminal
(nothing can advance it, the sweep ignores it) while the new one starts clean —
and the seller retypes nothing.

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
for each draft where status ∈ {CREATING, READY_FOR_PREVIEW, CANCELLED}
                    AND expiresAt < now:
    delete Cloudinary assets (originals + processed)
    remove any unfinished image jobs (by deterministic id)
    if status == CANCELLED: keep it (already terminal — assets were the point)
    else: tryTransition(currentStatus → EXPIRED)  # versioned; skips a draft that advanced
```

TTL = `DRAFT_TTL_HOURS` (default 24, range 1–168). `READY_FOR_PREVIEW` is included
so a preview the seller never confirmed doesn't orphan its assets forever;
`CANCELLED` is included purely as the **backstop** for a cancel path that died
between its transition and its asset deletion (re-deleting gone assets is a no-op).
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
| Pending cache expires (10 min) | Cache only — assets kept; `/start` re-presents the draft (sweep is the backstop). |
| Double-tap ⬅️ Назад | `reopenForEdit` is versioned: the second tap gets `count=0` and is told the draft can't be edited. |
| Double-tap 🖼 Изменить фото | The clone cancels the source under its observed version; the second tap finds it non-`READY_FOR_PREVIEW` and no-ops (no second clone, no double delete). |
| Clone write fails mid-way | One transaction — the source's `CANCELLED` rolls back, so the seller keeps their preview and can tap again. |
| Crash between a cancel/clone and its asset deletion | The sweep also covers **`CANCELLED`** drafts (assets reclaimed; status kept — not relabelled `EXPIRED`), so no cancel path can permanently orphan assets. |

**Orphan closure:** originals & processed assets, image rows, and jobs are all
owned by a draft; a draft always ends `PUBLISHED` (originals cleaned) or
`CANCELLED`/`EXPIRED` (all assets + jobs cleaned). The only transient orphan window
(assets created, draft not yet terminal) is bounded by the TTL sweep.

---

## 9. Configuration (all env, no magic numbers)

| Var | Default | Range | Meaning |
|---|---|---|---|
| `IMAGE_CONCURRENCY` | `5` | 1–10 | Concurrent image jobs per worker. |
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

## 11. State ownership (single source of truth)

`ProductDraft` owns all **business** state; the in-memory maps hold only what is
cheap to lose:

| State | Lives in | Lost on restart? |
|---|---|---|
| Form answers, images, assets, status | **`ProductDraft` (+ rows)** — Postgres | No |
| Dialogue position (`step`, `draftId`) | `WizardSessionStore` (in-memory) | Yes — `/start` rebuilds it from the draft (resume) |
| Sent-preview cache (`pending`) | `TelegramService.pending` (in-memory, 10-min TTL) | Yes — `/start` re-presents the `READY_FOR_PREVIEW` draft |

The `pending` TTL drops **only the cache**; it never deletes Cloudinary assets,
because the draft is still re-presentable. Asset lifetime belongs to the draft:
publish keeps the processed images (deletes the originals), cancel/expire deletes
everything.

There are **no** in-memory draft/image maps, no `setTimeout`-based business
expiry, and no wizard-session TTL: the draft's `expiresAt` + the hourly sweep are
the single TTL mechanism.

## 12. Cutover history (Phase 3)

Deleted at cutover — the flag (`PARALLEL_DRAFT_FLOW`), the inline synchronous
pipeline (`processImages` / `processOneImage`), the photos-last FSM states
(`PHOTOS`, `PROCESSING`) with `beginProcessing` / `backToPhotos` / `changePhotos` /
`hasProcessedPhotos`, the `WizardFlow` ('legacy' | 'parallel') discriminator, the
in-memory wizard-session TTL (`touchSession` / `sessionExpiry`), the session-held
`processedUrls` / `publicIds`, and `finalizeToPreview` / `rebuildPreviewFromSession`
/ `sendPreview` (ctx-based) / `setPending`.

Rollback is by **revert**, not by configuration.
