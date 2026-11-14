/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- mocked collaborators are untyped */
import { VehicleImageReconcileService } from './vehicle-image.reconcile.service';
import { currentIdentityStamp } from './vehicle-images.service';

const MODEL = { id: 'spark', makeId: 'chevrolet', name: 'Spark', bodyType: null, yearFrom: null, yearTo: null, variants: [] };
const vehicle = (over: Record<string, unknown> = {}) => ({
  id: 'veh_1', year: 2019, trimId: null, variantModelId: null,
  imageIdentityKey: null, imageReviewReason: null,
  identityModelId: null, identityGenerationId: null, identityFaceliftId: null, identityMarket: null,
  identityResolvedWith: null, model: MODEL, trim: null,
  ...over,
});
const REQUEST = (key: string, verification = 'unverified') => ({
  kind: 'request', verification, identityKey: key, identity: { modelId: 'spark' },
  resolved: { modelId: 'spark', generationId: null, faceliftId: null, marketRegion: verification === 'verified' ? 'UZ' : null },
});

function setup(rows: Record<string, unknown>[], plan: unknown) {
  const prisma: any = {
    vehicle: {
      findMany: jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    vehicleImageReconcileLog: { create: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const images: any = {
    planFor: jest.fn().mockResolvedValue(plan),
    stage: jest.fn(async (_tx: unknown, _id: string, p: any) => ({
      data: {
        imageIdentityKey: p.kind === 'request' ? p.identityKey : null,
        imageReviewReason: p.kind === 'review' ? p.reason : null,
        identityModelId: p.resolved?.modelId ?? null,
        identityGenerationId: null,
        identityFaceliftId: null,
        identityMarket: p.resolved?.marketRegion ?? null,
        identityResolvedWith: currentIdentityStamp(),
      },
      outboxId: p.kind === 'request' ? 'vio_1' : null,
    })),
    kick: jest.fn(),
  };
  return { svc: new VehicleImageReconcileService(prisma, images), prisma, images };
}

describe('VehicleImageReconcileService', () => {
  it('only looks at live vehicles resolved with another version', async () => {
    const { svc, prisma } = setup([], null);
    await svc.run({ apply: false });
    expect(prisma.vehicle.findMany.mock.calls[0][0].where).toEqual({
      deletedAt: null,
      id: { gt: '' },
      OR: [{ identityResolvedWith: null }, { identityResolvedWith: { not: currentIdentityStamp() } }],
    });
  });

  it('a dry run reports the upgrade and writes nothing', async () => {
    const { svc, prisma, images } = setup([vehicle({ imageReviewReason: 'market_unverified' })], REQUEST('k'.repeat(64)));
    const report = await svc.run({ apply: false });
    expect(report).toMatchObject({ upgraded: 1, scanned: 1 });
    expect(report.changes[0]).toMatchObject({ from: 'review:market_unverified', to: expect.stringMatching(/^unverified:spark:/) });
    expect(images.stage).not.toHaveBeenCalled();
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('applies an upgrade optimistically, logs previous and next, and kicks the request after commit', async () => {
    const { svc, prisma, images } = setup([vehicle()], REQUEST('k'.repeat(64)));
    const report = await svc.run({ apply: true, runId: 'rec_t' });
    expect(report.upgraded).toBe(1);
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'veh_1', deletedAt: null, imageIdentityKey: null, imageReviewReason: null, identityResolvedWith: null },
    }));
    const log = prisma.vehicleImageReconcileLog.create.mock.calls[0][0].data;
    expect(log).toMatchObject({ runId: 'rec_t', vehicleId: 'veh_1', previous: { imageIdentityKey: null }, next: { imageIdentityKey: 'k'.repeat(64) } });
    expect(images.kick).toHaveBeenCalledWith('vio_1');
  });

  it('never reassigns a verified vehicle; a disagreement is only counted', async () => {
    const verified = vehicle({ imageIdentityKey: 'v'.repeat(64), identityModelId: 'spark', identityMarket: 'UZ' });
    const { svc, images, prisma } = setup([verified], REQUEST('n'.repeat(64)));
    const report = await svc.run({ apply: true });
    expect(report).toMatchObject({ keptVerified: 1, verifiedConflicts: 1, upgraded: 0 });
    expect(images.stage).not.toHaveBeenCalled();
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith({
      where: { id: 'veh_1', identityResolvedWith: null },
      data: { identityResolvedWith: currentIdentityStamp() },
    });
  });

  it('never downgrades a vehicle that already has a request to review', async () => {
    const requested = vehicle({ imageIdentityKey: 'u'.repeat(64), identityModelId: 'spark' });
    const { svc, images } = setup([requested], { kind: 'review', reason: 'year_outside_model_range' });
    const report = await svc.run({ apply: true });
    expect(report).toMatchObject({ downgradesSkipped: 1, upgraded: 0 });
    expect(images.stage).not.toHaveBeenCalled();
  });

  it('leaves an unreadable catalog unstamped so the next run retries', async () => {
    const { svc, prisma } = setup([vehicle()], null);
    const report = await svc.run({ apply: true });
    expect(report.catalogUnreadable).toBe(1);
    expect(prisma.vehicle.updateMany).not.toHaveBeenCalled();
  });

  it('counts a concurrent owner change as a conflict and rolls the staging back', async () => {
    const { svc, prisma, images } = setup([vehicle()], REQUEST('k'.repeat(64)));
    prisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
    const report = await svc.run({ apply: true });
    expect(report).toMatchObject({ conflicts: 1, upgraded: 0 });
    expect(prisma.vehicleImageReconcileLog.create).not.toHaveBeenCalled();
    expect(images.kick).not.toHaveBeenCalled();
  });
});
