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
    status: DraftStatus.CREATING,
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
