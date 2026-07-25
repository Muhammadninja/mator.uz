// Unit tests for the TTL sweep (DraftCleanupProcessor.process). Collaborators are
// mocked; the focus is which drafts get cleaned and how their status is settled:
//   • CREATING / READY_FOR_PREVIEW → assets + jobs dropped, then versioned → EXPIRED.
//   • CANCELLED → assets + jobs dropped, but the status is KEPT (already terminal;
//     it is swept only to reclaim assets a crashed cancel path left behind).
//   • A draft that advanced mid-sweep loses the versioned transition and is skipped.
//   • One failing draft never wedges the rest of the batch.

import { DraftStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import { DraftCleanupProcessor } from './draft-cleanup.processor';
import { MAINTENANCE_JOBS } from './queue.constants';

function draft(over: Record<string, unknown> = {}) {
  return {
    id: 'draft_1',
    sellerId: 7,
    status: DraftStatus.CREATING,
    version: 2,
    images: [{ id: 'img_1', jobId: 'job_1' }],
    ...over,
  };
}

function make(expired: unknown[]) {
  const maintenanceQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const imageQueue = { remove: jest.fn().mockResolvedValue(undefined) };
  const drafts = {
    findExpired: jest.fn().mockResolvedValue(expired),
    collectPublicIds: jest.fn().mockResolvedValue(['asset_1']),
    tryTransition: jest.fn().mockResolvedValue(true),
  };
  const cloudinary = { deleteAssets: jest.fn().mockResolvedValue(undefined) };
  const telemetry = { event: jest.fn(), metric: jest.fn() };
  const processor = new DraftCleanupProcessor(
    maintenanceQueue as never,
    imageQueue as never,
    drafts as never,
    cloudinary as never,
    telemetry as never,
  );
  // Silence the processor's logger.
  Object.assign(processor, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
  });
  return { processor, imageQueue, drafts, cloudinary, telemetry };
}

const sweepJob = { name: MAINTENANCE_JOBS.DRAFT_CLEANUP } as Job;

describe('DraftCleanupProcessor — TTL sweep', () => {
  it('ignores jobs that are not the draft-cleanup sweep', async () => {
    const { processor, drafts } = make([draft()]);
    await processor.process({ name: 'something-else' } as Job);
    expect(drafts.findExpired).not.toHaveBeenCalled();
  });

  it('cleans a CREATING draft and transitions it to EXPIRED under the lock', async () => {
    const { processor, drafts, cloudinary, imageQueue, telemetry } = make([
      draft(),
    ]);

    await processor.process(sweepJob);

    expect(cloudinary.deleteAssets).toHaveBeenCalledWith(['asset_1']);
    expect(imageQueue.remove).toHaveBeenCalledWith('job_1');
    expect(drafts.tryTransition).toHaveBeenCalledWith(
      'draft_1',
      DraftStatus.CREATING,
      DraftStatus.EXPIRED,
      2,
    );
    expect(telemetry.metric).toHaveBeenCalled(); // draft.expired
  });

  it('cleans a READY_FOR_PREVIEW draft (an unconfirmed preview) from its own status', async () => {
    const { processor, drafts } = make([
      draft({ status: DraftStatus.READY_FOR_PREVIEW, version: 5 }),
    ]);

    await processor.process(sweepJob);

    expect(drafts.tryTransition).toHaveBeenCalledWith(
      'draft_1',
      DraftStatus.READY_FOR_PREVIEW,
      DraftStatus.EXPIRED,
      5,
    );
  });

  it('reclaims a COMMITTING draft whose commit died before the product write', async () => {
    // The reason the confirm path claims COMMITTING instead of PUBLISHED: a crashed
    // commit stays sweepable, so its Cloudinary assets are reclaimed. A PUBLISHED
    // draft is excluded from the sweep entirely and would leak them forever.
    const { processor, drafts, cloudinary, imageQueue, telemetry } = make([
      draft({ status: DraftStatus.COMMITTING, version: 6 }),
    ]);

    await processor.process(sweepJob);

    expect(cloudinary.deleteAssets).toHaveBeenCalledWith(['asset_1']);
    expect(imageQueue.remove).toHaveBeenCalledWith('job_1');
    expect(drafts.tryTransition).toHaveBeenCalledWith(
      'draft_1',
      DraftStatus.COMMITTING,
      DraftStatus.EXPIRED,
      6,
    );
    expect(telemetry.metric).toHaveBeenCalled(); // draft.expired
  });

  it('sweeping a COMMITTING draft whose product WAS written deletes only the originals', async () => {
    // The crash window this whole design exists for: product.upsert() succeeded,
    // publishDraft() never ran. collectPublicIds spares the processed assets the
    // product now claims, so the sweep reclaims only the intermediate originals —
    // the live product keeps every image.
    const { processor, drafts, cloudinary } = make([
      draft({ status: DraftStatus.COMMITTING, version: 6 }),
    ]);
    drafts.collectPublicIds.mockResolvedValue(['orig_1']); // processed ones spared

    await processor.process(sweepJob);

    expect(cloudinary.deleteAssets).toHaveBeenCalledWith(['orig_1']);
    const deleted = cloudinary.deleteAssets.mock.calls.flat(2);
    expect(deleted).not.toContain('proc_1');
    // The draft row is settled, but nothing in the sweep touches product tables.
    expect(drafts.tryTransition).toHaveBeenCalledWith(
      'draft_1',
      DraftStatus.COMMITTING,
      DraftStatus.EXPIRED,
      6,
    );
  });

  it('a commit that finishes late still wins: the sweep loses the version race', async () => {
    // The sweep only sees a COMMITTING draft once expiresAt has passed, and even
    // then the versioned transition defers to a commit that completed meanwhile.
    const { processor, drafts, telemetry } = make([
      draft({ status: DraftStatus.COMMITTING, version: 6 }),
    ]);
    drafts.tryTransition.mockResolvedValue(false); // draft moved on (→ PUBLISHED)

    await processor.process(sweepJob);

    expect(telemetry.metric).not.toHaveBeenCalled();
  });

  it('reclaims a CANCELLED draft’s assets but KEEPS its status (no relabel to EXPIRED)', async () => {
    const { processor, drafts, cloudinary, imageQueue, telemetry } = make([
      draft({ status: DraftStatus.CANCELLED }),
    ]);

    await processor.process(sweepJob);

    // The point of sweeping a cancelled draft: assets a crashed cancel path left.
    expect(cloudinary.deleteAssets).toHaveBeenCalledWith(['asset_1']);
    expect(imageQueue.remove).toHaveBeenCalledWith('job_1');
    // …but it is already terminal, so its history is preserved.
    expect(drafts.tryTransition).not.toHaveBeenCalled();
    expect(telemetry.metric).not.toHaveBeenCalled();
  });

  it('skips the transition when the draft advanced mid-sweep (lost the version race)', async () => {
    const { processor, drafts, telemetry } = make([draft()]);
    drafts.tryTransition.mockResolvedValue(false);

    await processor.process(sweepJob);

    expect(telemetry.metric).not.toHaveBeenCalled();
  });

  it('one failing draft does not wedge the rest of the batch', async () => {
    const { processor, drafts } = make([
      draft({ id: 'bad' }),
      draft({ id: 'good' }),
    ]);
    drafts.collectPublicIds
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(['asset_2']);

    await expect(processor.process(sweepJob)).resolves.toBeUndefined();

    // The second draft still got its transition.
    expect(drafts.tryTransition).toHaveBeenCalledWith(
      'good',
      DraftStatus.CREATING,
      DraftStatus.EXPIRED,
      2,
    );
  });

  it('does nothing when no drafts are expired', async () => {
    const { processor, cloudinary, drafts } = make([]);
    await processor.process(sweepJob);
    expect(cloudinary.deleteAssets).not.toHaveBeenCalled();
    expect(drafts.tryTransition).not.toHaveBeenCalled();
  });
});
