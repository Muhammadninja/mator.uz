// Unit tests for DraftCoordinator — the rendezvous brain. ProductDraftService is
// mocked with a small STATEFUL double so the two-track ordering and the
// optimistic-locked transition are exercised for real:
//   • form-then-image and image-then-form both reach exactly one preview.
//   • preview fires ONLY when form complete AND all images READY.
//   • any FAILED image at the batch boundary → images_failed, no preview.
//   • still-processing images → no event yet.
//   • a lost optimistic race (version bumped underneath) re-reads and does not
//     double-emit / does not advance a terminal draft.

import {
  DraftImageStatus,
  DraftStatus,
  OilType,
  ProductKind,
} from '@prisma/client';
import { DraftCoordinator } from './draft-coordinator';
import { DraftEvent } from './draft-events';

type Img = { id: string; status: DraftImageStatus };

/** Minimal mutable draft matching what the coordinator reads. */
function makeDraft(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'draft_1',
    tgId: 123n,
    // Annotated as the full enum, not left to infer the 'CREATING' literal: the
    // stateful drafts mock below transitions this field, which a literal type
    // would reject.
    status: DraftStatus.CREATING as DraftStatus,
    version: 0,
    kind: ProductKind.SPARE_PART,
    title: 'Amortizator',
    brand: 'Chevrolet',
    model: 'Cobalt',
    category: 'SUSPENSION_AND_STEERING',
    vehicleCategoryId: 'suspension-and-steering',
    categoryId: 'suspension',
    oilViscosity: null,
    oilType: null,
    oilVolumeMl: null,
    antifreezeWeightG: null,
    priceUzs: 250000,
    images: [] as Img[],
    ...over,
  };
}

/** A fully-answered MOTOR_OIL draft: no vehicle, no category — by design. */
function makeOilDraft(over: Partial<Record<string, unknown>> = {}) {
  return makeDraft({
    kind: ProductKind.MOTOR_OIL,
    title: 'Mobil 1 ESP 5W-30 4L',
    brand: null,
    model: null,
    category: null,
    vehicleCategoryId: null,
    categoryId: null,
    oilViscosity: '5W-30',
    oilType: OilType.SYNTHETIC,
    oilVolumeMl: 4000,
    ...over,
  });
}

/** A fully-answered ANTIFREEZE draft: no vehicle, no category, no oil fields —
 *  its ONLY required attribute is the packaged net weight. */
function makeAntifreezeDraft(over: Partial<Record<string, unknown>> = {}) {
  return makeDraft({
    kind: ProductKind.ANTIFREEZE,
    title: 'Antifriz G12 5kg',
    brand: null,
    model: null,
    category: null,
    vehicleCategoryId: null,
    categoryId: null,
    antifreezeWeightG: 5000,
    ...over,
  });
}

/**
 * Stateful ProductDraftService double. `findWithImages` returns the current draft;
 * `tryTransition` honours the id+status+version guard and bumps version, exactly
 * like the real optimistic lock — so racing calls behave realistically.
 */
function makeDraftsMock(draft: ReturnType<typeof makeDraft>) {
  return {
    current: draft,
    findWithImages: jest.fn(async () => draft),
    tryTransition: jest.fn(
      async (
        _id: string,
        from: DraftStatus,
        to: DraftStatus,
        expectedVersion: number,
      ) => {
        if (draft.status === from && draft.version === expectedVersion) {
          draft.status = to;
          draft.version += 1;
          return true;
        }
        return false;
      },
    ),
  };
}

function makeEvents() {
  return { emit: jest.fn() };
}

/** No-op DraftTelemetry double (observability is not asserted here). */
function makeTelemetry() {
  return { event: jest.fn(), metric: jest.fn() };
}

describe('DraftCoordinator rendezvous', () => {
  const READY = DraftImageStatus.READY;
  const PROCESSING = DraftImageStatus.PROCESSING;
  const FAILED = DraftImageStatus.FAILED;

  it('fires preview once when the form completes AFTER images are all READY', async () => {
    const draft = makeDraft({
      images: [
        { id: 'a', status: READY },
        { id: 'b', status: READY },
      ],
    });
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );

    await coord.onFormStep('draft_1'); // form was the last track

    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(DraftEvent.READY_FOR_PREVIEW, {
      draftId: 'draft_1',
      tgId: 123n,
    });
    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
  });

  it('fires preview once when the last image completes AFTER the form is done', async () => {
    const draft = makeDraft({
      images: [
        { id: 'a', status: READY },
        { id: 'b', status: READY },
      ],
    });
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );

    await coord.onImageSettled('draft_1'); // images were the last track

    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      DraftEvent.READY_FOR_PREVIEW,
      expect.objectContaining({ draftId: 'draft_1' }),
    );
  });

  it('does NOT fire preview while any image is still PROCESSING', async () => {
    const draft = makeDraft({
      images: [
        { id: 'a', status: READY },
        { id: 'b', status: PROCESSING },
      ],
    });
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );

    await coord.onImageSettled('draft_1');

    expect(events.emit).not.toHaveBeenCalled();
    expect(draft.status).toBe(DraftStatus.CREATING);
  });

  it('does NOT fire preview when images are READY but the form is incomplete', async () => {
    const draft = makeDraft({
      priceUzs: null, // missing required field
      images: [{ id: 'a', status: READY }],
    });
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );

    await coord.onImageSettled('draft_1');

    expect(events.emit).not.toHaveBeenCalled();
    expect(draft.status).toBe(DraftStatus.CREATING);
  });

  it('emits images_failed (and no preview) when the batch settled with a failure', async () => {
    const draft = makeDraft({
      images: [
        { id: 'a', status: READY },
        { id: 'b', status: FAILED },
      ],
    });
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );

    await coord.onImageSettled('draft_1');

    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(DraftEvent.IMAGES_FAILED, {
      draftId: 'draft_1',
      tgId: 123n,
      failedCount: 1,
    });
    expect(draft.status).toBe(DraftStatus.CREATING); // draft (and form data) kept
  });

  it('does nothing when the draft is already past CREATING (terminal/advanced)', async () => {
    const draft = makeDraft({
      status: DraftStatus.READY_FOR_PREVIEW,
      images: [{ id: 'a', status: READY }],
    });
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );

    await coord.onFormStep('draft_1');

    expect(events.emit).not.toHaveBeenCalled();
    expect(drafts.tryTransition).not.toHaveBeenCalled();
  });

  it('no-ops when the draft does not exist', async () => {
    const events = makeEvents();
    const drafts = {
      findWithImages: jest.fn(async () => null),
      tryTransition: jest.fn(),
    };
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );

    await coord.onImageSettled('missing');

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('two simultaneous settles produce exactly one preview (optimistic single-winner)', async () => {
    const draft = makeDraft({
      images: [
        { id: 'a', status: READY },
        { id: 'b', status: READY },
      ],
    });
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );

    // Both tracks reach the rendezvous "at once".
    await Promise.all([
      coord.onFormStep('draft_1'),
      coord.onImageSettled('draft_1'),
    ]);

    const previewEmits = events.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === DraftEvent.READY_FOR_PREVIEW,
    );
    expect(previewEmits).toHaveLength(1);
    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
  });
});

// ── Per-KIND rendezvous ─────────────────────────────────────────────────────
// Regression: the coordinator used to carry its OWN copy of the "form complete"
// rule, which demanded brand + model + category. A motor oil never has those —
// its questionnaire deliberately does not ask — so a fully-answered oil whose
// images had all reached READY silently failed the gate: no transition, no
// event, no exception. The seller sat on "⏳ Завершаем обработку фото…" forever
// while the logs showed a perfectly healthy image pipeline.
//
// The rule now lives once in the draft domain (isDraftFormComplete) and both the
// coordinator and TelegramService call it, so they cannot drift apart again.
describe('DraftCoordinator rendezvous — per product kind', () => {
  const READY = DraftImageStatus.READY;

  /** Build a coordinator over `draft` and return it with its doubles. */
  function coordinatorFor(draft: ReturnType<typeof makeDraft>) {
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );
    return { coord, drafts, events };
  }

  const previewEmits = (events: ReturnType<typeof makeEvents>) =>
    events.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === DraftEvent.READY_FOR_PREVIEW,
    );

  it('advances a MOTOR_OIL draft that has NO brand/model/category', async () => {
    const draft = makeOilDraft({ images: [{ id: 'a', status: READY }] });
    const { coord, events } = coordinatorFor(draft);

    await coord.onImageSettled('draft_1');

    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
    expect(previewEmits(events)).toHaveLength(1);
    expect(previewEmits(events)[0][1]).toMatchObject({
      draftId: 'draft_1',
      tgId: 123n,
    });
  });

  it('emits exactly once for an oil when both tracks race', async () => {
    const draft = makeOilDraft({ images: [{ id: 'a', status: READY }] });
    const { coord, events } = coordinatorFor(draft);

    await Promise.all([
      coord.onFormStep('draft_1'),
      coord.onImageSettled('draft_1'),
    ]);

    expect(previewEmits(events)).toHaveLength(1);
  });

  it.each([
    ['viscosity', { oilViscosity: null }],
    ['oil type', { oilType: null }],
    ['volume', { oilVolumeMl: null }],
    ['title', { title: null }],
    ['price', { priceUzs: null }],
  ])('waits when an oil is missing its %s', async (_label, missing) => {
    const draft = makeOilDraft({
      images: [{ id: 'a', status: READY }],
      ...missing,
    });
    const { coord, events } = coordinatorFor(draft);

    await coord.onImageSettled('draft_1');

    expect(draft.status).toBe(DraftStatus.CREATING);
    expect(previewEmits(events)).toHaveLength(0);
  });

  it('does NOT require oil attributes from a SPARE_PART (regression)', async () => {
    // The mirror of the original bug: the shared rule must not start demanding
    // viscosity/type/volume from a spare part.
    const draft = makeDraft({ images: [{ id: 'a', status: READY }] });
    const { coord, events } = coordinatorFor(draft);

    await coord.onImageSettled('draft_1');

    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
    expect(previewEmits(events)).toHaveLength(1);
  });

  it.each([
    ['brand', { brand: null }],
    ['model', { model: null }],
    // The dynamic tree node — the category requirement since categories became
    // admin-editable (a custom category mirrors no enum).
    ['categoryId', { categoryId: null }],
  ])('still waits when a spare part is missing its %s', async (_l, missing) => {
    const draft = makeDraft({
      images: [{ id: 'a', status: READY }],
      ...missing,
    });
    const { coord, events } = coordinatorFor(draft);

    await coord.onImageSettled('draft_1');

    expect(draft.status).toBe(DraftStatus.CREATING);
    expect(previewEmits(events)).toHaveLength(0);
  });
});

// ── The waiting rule, per reported bug ──────────────────────────────────────
// Regression for the SECOND instance of "the seller waits forever while every
// image is READY". The first was MOTOR_OIL (a duplicated completeness rule); this
// one is ANTIFREEZE, and the completeness rule was innocent — `handleFormAdvance`
// simply never passed `antifreezeWeightG` to `updateForm`, so the kind's one
// required column stayed NULL and the rendezvous was correctly-but-permanently
// blocked on the FORM axis while the image logs looked perfect.
//
// These tests pin the property that actually matters to the seller: once the last
// image reaches READY on a fully-answered draft, the flow STOPS waiting — exactly
// once, regardless of arrival order, repeats, or a stale caller.
describe('DraftCoordinator — stop waiting once images are READY', () => {
  const READY = DraftImageStatus.READY;
  const PROCESSING = DraftImageStatus.PROCESSING;
  const FAILED = DraftImageStatus.FAILED;

  function coordinatorFor(draft: ReturnType<typeof makeDraft>) {
    const drafts = makeDraftsMock(draft);
    const events = makeEvents();
    const coord = new DraftCoordinator(
      drafts as never,
      events as never,
      makeTelemetry() as never,
    );
    return { coord, drafts, events };
  }

  const previews = (events: ReturnType<typeof makeEvents>) =>
    events.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === DraftEvent.READY_FOR_PREVIEW,
    );

  // Case 1 — a single image going READY ends the wait.
  it('Case 1: one image → READY stops the waiting and advances', async () => {
    const draft = makeAntifreezeDraft({
      images: [{ id: 'i1', status: READY }],
    });
    const { coord, events } = coordinatorFor(draft);

    await coord.onImageSettled('draft_1');

    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
    expect(previews(events)).toHaveLength(1);
  });

  // Case 2 — with two images the flow waits for the SECOND, then advances.
  it('Case 2: two images → waits after #1, advances after #2', async () => {
    const images: Img[] = [
      { id: 'i1', status: PROCESSING },
      { id: 'i2', status: PROCESSING },
    ];
    const draft = makeAntifreezeDraft({ images });
    const { coord, events } = coordinatorFor(draft);

    images[0].status = READY; // image #1 settles
    await coord.onImageSettled('draft_1');
    expect(draft.status).toBe(DraftStatus.CREATING);
    expect(previews(events)).toHaveLength(0);

    images[1].status = READY; // image #2 settles — batch boundary
    await coord.onImageSettled('draft_1');
    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
    expect(previews(events)).toHaveLength(1);
  });

  // Case 3 — arrival order is irrelevant; only the batch boundary matters.
  it('Case 3: settle order does not matter (#2 before #1)', async () => {
    const images: Img[] = [
      { id: 'i1', status: PROCESSING },
      { id: 'i2', status: PROCESSING },
    ];
    const draft = makeAntifreezeDraft({ images });
    const { coord, events } = coordinatorFor(draft);

    images[1].status = READY; // the LATER image settles first
    await coord.onImageSettled('draft_1');
    expect(previews(events)).toHaveLength(0);

    images[0].status = READY;
    await coord.onImageSettled('draft_1');
    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
    expect(previews(events)).toHaveLength(1);
  });

  // Case 4 — a redelivered/duplicated settle must not advance the flow twice.
  it('Case 4: a repeated image.ready settle emits the preview only once', async () => {
    const draft = makeAntifreezeDraft({
      images: [{ id: 'i1', status: READY }],
    });
    const { coord, events } = coordinatorFor(draft);

    await coord.onImageSettled('draft_1');
    await coord.onImageSettled('draft_1'); // duplicate delivery
    await coord.onImageSettled('draft_1'); // and another

    expect(previews(events)).toHaveLength(1);
    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
  });

  // Case 5 — the caller's view is irrelevant: the coordinator re-reads the draft
  // on every call, so a stale in-memory snapshot cannot keep the seller waiting.
  it('Case 5: a stale caller snapshot does not block — state is re-read', async () => {
    const images: Img[] = [{ id: 'i1', status: PROCESSING }];
    const draft = makeAntifreezeDraft({ images });
    const { coord, drafts, events } = coordinatorFor(draft);

    // A caller holding this stale object would still see PROCESSING…
    const staleSnapshot = { ...draft, images: [{ ...images[0] }] };
    expect(staleSnapshot.images[0].status).toBe(PROCESSING);

    images[0].status = READY; // …while the DB has since moved to READY.
    await coord.onFormStep('draft_1');

    expect(drafts.findWithImages).toHaveBeenCalledWith('draft_1');
    expect(draft.status).toBe(DraftStatus.READY_FOR_PREVIEW);
    expect(previews(events)).toHaveLength(1);
  });

  // Case 6 — a genuine failure is NOT success: no preview, draft stays CREATING,
  // and the seller gets the existing retry/cancel offer instead.
  it('Case 6: one FAILED image blocks the preview and reports the failure', async () => {
    const draft = makeAntifreezeDraft({
      images: [
        { id: 'i1', status: READY },
        { id: 'i2', status: FAILED },
      ],
    });
    const { coord, events } = coordinatorFor(draft);

    await coord.onImageSettled('draft_1');

    expect(previews(events)).toHaveLength(0);
    expect(draft.status).toBe(DraftStatus.CREATING);
    const failures = events.emit.mock.calls.filter(
      (c: unknown[]) => c[0] === DraftEvent.IMAGES_FAILED,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][1]).toMatchObject({
      draftId: 'draft_1',
      failedCount: 1,
    });
  });

  // The bug itself, stated as the coordinator sees it: a draft whose weight was
  // never persisted must NOT advance (proving the gate is real), while the same
  // draft with the weight saved advances immediately. Before the fix every
  // antifreeze draft was permanently in the first state.
  it('does not advance an ANTIFREEZE draft whose weight was never saved', async () => {
    const draft = makeAntifreezeDraft({
      antifreezeWeightG: null, // what the missing updateForm field produced
      images: [{ id: 'i1', status: READY }],
    });
    const { coord, events } = coordinatorFor(draft);

    await coord.onImageSettled('draft_1');

    expect(draft.status).toBe(DraftStatus.CREATING);
    expect(previews(events)).toHaveLength(0);
  });
});
