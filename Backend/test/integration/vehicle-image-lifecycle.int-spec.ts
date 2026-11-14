/**
 * Garage vehicle image lifecycle on a REAL PostgreSQL: what a Prisma mock cannot
 * show — the partial unique index that keeps one pending request per identity
 * under concurrent creates, and the reconcile job's idempotent, resumable,
 * optimistic re-resolution of saved vehicles with its revert.
 *
 * Run: TEST_DATABASE_URL=postgresql://…@127.0.0.1:…/mator_…_test npm run test:integration
 */
import { randomUUID } from 'node:crypto';
import { VehicleImageOutboxStatus, VehicleImageStatus } from '@prisma/client';
import { describeWithDb, integrationPrisma } from '../utils/integration-db';
import { VehicleImagesService, currentIdentityStamp } from '../../src/garage/vehicle-images/vehicle-images.service';
import { VehicleImageReconcileService } from '../../src/garage/vehicle-images/vehicle-image.reconcile.service';
import { VehicleImageDeliveryService } from '../../src/garage/vehicle-images/vehicle-image.delivery.service';
import { VARIANT_SELECT } from '../../src/garage/vehicles/vehicle.presenter';

const RUN = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${RUN}`;

describeWithDb('vehicle image lifecycle (real PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const queue = { add: jest.fn().mockResolvedValue({}), addBulk: jest.fn().mockResolvedValue([]) };
  const delivery = { enabled: true };
  const images = new VehicleImagesService(prisma as never, delivery as never, queue as never);
  const reconcile = new VehicleImageReconcileService(prisma as never, images);
  let userId: string;

  const make = id('mk');
  const sparkId = id('spark');
  const camryId = id('camry');

  beforeAll(async () => {
    userId = (await prisma.appUser.create({ data: { id: randomUUID() } })).id;
    await prisma.vehicleMake.create({ data: { id: make, name: `Make ${RUN}` } });
    await prisma.vehicleModelRef.createMany({
      data: [
        { id: sparkId, makeId: make, name: 'Spark' },
        { id: camryId, makeId: make, name: 'Camry', bodyType: 'Sedan' },
      ],
    });
  });

  afterAll(async () => {
    const vehicles = await prisma.vehicle.findMany({ where: { userId }, select: { id: true, imageIdentityKey: true } });
    const keys = vehicles.map((v) => v.imageIdentityKey).filter((k): k is string => !!k);
    await prisma.vehicleImageReconcileLog.deleteMany({ where: { vehicleId: { in: vehicles.map((v) => v.id) } } });
    await prisma.vehicle.deleteMany({ where: { userId } });
    await prisma.vehicleImageOutbox.deleteMany({ where: { identityKey: { in: keys } } });
    await prisma.vehicleImageIdentity.deleteMany({ where: { identityKey: { in: keys } } });
    await prisma.vehicleModelRef.deleteMany({ where: { makeId: make } });
    await prisma.vehicleMake.delete({ where: { id: make } });
    await prisma.appUser.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const modelRow = (modelId: string) =>
    prisma.vehicleModelRef.findUniqueOrThrow({
      where: { id: modelId },
      include: { variants: { select: VARIANT_SELECT } },
    });

  /** A Garage create the way VehiclesService.create does it: plan → stage + insert in one transaction. */
  async function addVehicle(modelId: string, year: number) {
    const plan = await images.planFor({ year, model: await modelRow(modelId), trim: null, chosenVariantId: null });
    const vehicleId = `veh_${randomUUID()}`;
    await prisma.$transaction(async (tx) => {
      const staged = await images.stage(tx, vehicleId, plan);
      await tx.vehicle.create({
        data: { id: vehicleId, userId, makeId: make, modelId, year, ...staged.data },
      });
    });
    return vehicleId;
  }

  it('a brand-new model of a make the registry has never seen enters the pipeline as one unverified request', async () => {
    const vehicleId = await addVehicle(camryId, 2021);
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, include: { imageIdentity: true } });
    expect(vehicle).toMatchObject({ imageReviewReason: null, identityModelId: camryId, identityMarket: null,
      identityResolvedWith: currentIdentityStamp() });
    expect(vehicle.imageIdentity).toMatchObject({ status: VehicleImageStatus.PENDING });
    expect(vehicle.imageIdentity!.identity).toMatchObject({ modelId: camryId, identityStatus: 'unverified' });
    const outbox = await prisma.vehicleImageOutbox.findMany({ where: { identityKey: vehicle.imageIdentityKey! } });
    expect(outbox).toHaveLength(1);
  });

  it('fifty owners adding the same car at once produce exactly one pending request', async () => {
    const ids = await Promise.all(Array.from({ length: 50 }, () => addVehicle(sparkId, 2017)));
    const keys = new Set(
      (await prisma.vehicle.findMany({ where: { id: { in: ids } }, select: { imageIdentityKey: true } }))
        .map((v) => v.imageIdentityKey),
    );
    expect(keys.size).toBe(1);
    const [key] = [...keys];
    const pending = await prisma.vehicleImageOutbox.count({
      where: { identityKey: key!, status: VehicleImageOutboxStatus.PENDING },
    });
    expect(pending).toBe(1);
  });

  it('re-resolves vehicles saved before (legacy review, never resolved) once, resumably, and reverts', async () => {
    const legacy = async (over: Record<string, unknown>) => {
      const vehicleId = `veh_${randomUUID()}`;
      await prisma.vehicle.create({ data: { id: vehicleId, userId, makeId: make, modelId: sparkId, year: 2019, ...over } });
      return vehicleId;
    };
    const reviewed = await legacy({ imageReviewReason: 'market_unverified', identityResolvedWith: null });
    const unresolved = await legacy({});
    const deleted = await legacy({ deletedAt: new Date() });

    const dry = await reconcile.run({ apply: false });
    expect(dry.upgraded).toBeGreaterThanOrEqual(2);
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: reviewed } })).imageReviewReason).toBe('market_unverified');

    // Resumable: one vehicle per batch, one batch: the next run continues where it stopped.
    const first = await reconcile.run({ apply: true, batchSize: 1, maxBatches: 1, runId: `rec_${RUN}_a` });
    expect(first.scanned).toBe(1);
    const second = await reconcile.run({ apply: true, runId: `rec_${RUN}_b` });
    const again = await reconcile.run({ apply: true, runId: `rec_${RUN}_c` });
    expect(again.scanned).toBe(0);

    for (const vehicleId of [reviewed, unresolved]) {
      const v = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, include: { imageIdentity: true } });
      expect(v).toMatchObject({ imageReviewReason: null, identityModelId: sparkId, identityMarket: null,
        identityResolvedWith: currentIdentityStamp() });
      expect(v.imageIdentity!.identity).toMatchObject({ identityStatus: 'unverified' });
    }
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: deleted } })).identityResolvedWith).toBeNull();

    const logged = await prisma.vehicleImageReconcileLog.findMany({
      where: { runId: { in: [first.runId, second.runId] }, vehicleId: { in: [reviewed, unresolved] } },
    });
    expect(logged).toHaveLength(2);
    const reviewedRun = logged.find((row) => row.vehicleId === reviewed)!.runId;
    const preview = await reconcile.revert(reviewedRun, false);
    expect(preview.reverted).toBeGreaterThanOrEqual(1);
    const reverted = await reconcile.revert(reviewedRun, true);
    expect(reverted.reverted).toBeGreaterThanOrEqual(1);
    const back = await prisma.vehicle.findUniqueOrThrow({ where: { id: reviewed } });
    expect(back).toMatchObject({ imageReviewReason: 'market_unverified', imageIdentityKey: null,
      identityResolvedWith: currentIdentityStamp() });
    // Reverted vehicles keep the run's stamp: the next pass leaves them alone.
    expect((await reconcile.run({ apply: true })).scanned).toBe(0);
  });

  it('never reassigns a vehicle the owner changed while a run was deciding', async () => {
    const vehicleId = `veh_${randomUUID()}`;
    await prisma.vehicle.create({ data: { id: vehicleId, userId, makeId: make, modelId: camryId, year: 2020 } });
    const original = images.stage.bind(images);
    const spy = jest.spyOn(images, 'stage').mockImplementationOnce(async (tx, vid, plan) => {
      // The owner's own write lands between the run's read and its write.
      await prisma.vehicle.update({ where: { id: vehicleId }, data: { identityResolvedWith: 'owner-edit' } });
      return original(tx, vid, plan);
    });
    const report = await reconcile.run({ apply: true });
    spy.mockRestore();
    expect(report.conflicts).toBe(1);
    expect(await prisma.vehicleImageReconcileLog.count({ where: { runId: report.runId, vehicleId } })).toBe(0);
  });

  it('revives an identity whose request died during an outage, once, when the pipeline is ready again', async () => {
    const vehicleId = await addVehicle(camryId, 2019);
    const { imageIdentityKey: key } = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    await prisma.vehicleImageOutbox.updateMany({ where: { identityKey: key! }, data: { status: VehicleImageOutboxStatus.DEAD } });
    await prisma.vehicleImageIdentity.update({
      where: { identityKey: key! },
      data: { status: VehicleImageStatus.UNAVAILABLE, reason: 'dispatch_failed' },
    });
    await prisma.$executeRaw`UPDATE vehicle_image_identities SET updated_at = now() - interval '2 hours' WHERE identity_key = ${key}`;
    const client = {
      enabled: true,
      health: jest.fn().mockResolvedValue({ ready: true, registryMatches: true, registrySha256: 'x', contract: 2, capabilities: null }),
    };
    const reviver = new VehicleImageDeliveryService(prisma as never, client as never, queue as never);
    const [first, second] = [await reviver.reviveStalled(), await reviver.reviveStalled()];
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);
    expect(await prisma.vehicleImageIdentity.findUniqueOrThrow({ where: { identityKey: key! } }))
      .toMatchObject({ status: VehicleImageStatus.PENDING, reason: null });
    expect(await prisma.vehicleImageOutbox.count({ where: { identityKey: key!, status: VehicleImageOutboxStatus.PENDING } })).toBe(1);
  });
});
