// Unit tests for DraftCoordinator — the rendezvous brain. ProductDraftService is
// mocked with a small STATEFUL double so the two-track ordering and the
// optimistic-locked transition are exercised for real:
//   • form-then-image and image-then-form both reach exactly one preview.
//   • preview fires ONLY when form complete AND all images READY.
//   • any FAILED image at the batch boundary → images_failed, no preview.
//   • still-processing images → no event yet.
//   • a lost optimistic race (version bumped underneath) re-reads and does not
//     double-emit / does not advance a terminal draft.

import { DraftImageStatus, DraftStatus } from '@prisma/client';
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
    title: 'Amortizator',
    brand: 'Chevrolet',
    model: 'Cobalt',
    category: 'SUSPENSION_AND_STEERING',
    priceUzs: 250000,
    images: [] as Img[],
    ...over,
  };
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
    const coord = new DraftCoordinator(drafts as never, events as never);

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
    const coord = new DraftCoordinator(drafts as never, events as never);

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
    const coord = new DraftCoordinator(drafts as never, events as never);

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
    const coord = new DraftCoordinator(drafts as never, events as never);

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
    const coord = new DraftCoordinator(drafts as never, events as never);

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
    const coord = new DraftCoordinator(drafts as never, events as never);

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
    const coord = new DraftCoordinator(drafts as never, events as never);

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
    const coord = new DraftCoordinator(drafts as never, events as never);

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
