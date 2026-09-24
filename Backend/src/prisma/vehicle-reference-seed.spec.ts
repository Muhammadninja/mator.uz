import {
  fakeReferenceDb,
  PROD_REFERENCE_2026_09_25 as PROD,
  cloneSnapshot,
  referenceMake,
} from '../../test/utils/vehicle-reference-fixture';
import {
  ExistingModel,
  planVehicleReferenceSeed,
  VEHICLE_REFERENCE_DATASET,
} from './vehicle-reference-plan';
import { formatVehicleReferenceReport } from './vehicle-reference-report';
import {
  referenceCacheKeys,
  ReferenceSeedAbort,
  runVehicleReferenceSeed,
} from './vehicle-reference-seed';

describe('runVehicleReferenceSeed', () => {
  it('dry-run only reads', async () => {
    const { prisma, db, writes } = fakeReferenceDb(PROD);
    const { plan, applied } = await runVehicleReferenceSeed(prisma, {
      apply: false,
    });
    expect(applied).toBe(false);
    expect(plan.newModels).toHaveLength(17);
    expect(writes).toEqual([]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('applies creates plus one guarded is_active update in one serializable transaction', async () => {
    const { prisma, db, writes, txOptions, state } = fakeReferenceDb(PROD);
    const { applied } = await runVehicleReferenceSeed(prisma, { apply: true });

    expect(applied).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(txOptions).toEqual([
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    ]);
    expect(writes).toHaveLength(4 + 17 + 1);
    expect(writes.at(-1)).toBe('updateMany make leapmotor {"isActive":false}');
    // Every pre-existing row is byte-identical apart from leapmotor.is_active.
    const existing = new Set(PROD.models.map((m) => m.id));
    expect(state().models.filter((m) => existing.has(m.id))).toEqual(
      PROD.models,
    );
    expect(state().makes.find((m) => m.id === 'leapmotor')).toEqual(
      referenceMake('leapmotor', 'Leapmotor', 10, false, true),
    );
    expect(state().makes.find((m) => m.id === 'skoda')).toEqual(
      referenceMake('skoda', 'Skoda', 14, true, false),
    );
  });

  it('is idempotent: a second apply plans and writes nothing', async () => {
    const { prisma, writes } = fakeReferenceDb(PROD);
    await runVehicleReferenceSeed(prisma, { apply: true });
    const firstRun = writes.length;

    const { plan, applied } = await runVehicleReferenceSeed(prisma, {
      apply: true,
    });
    expect(applied).toBe(false);
    expect(writes).toHaveLength(firstRun);
    expect(plan.unchangedMakes).toHaveLength(4);
    expect(plan.unchangedModels).toHaveLength(17);
    expect(plan.stateUnchanged).toEqual(['leapmotor']);
    expect(referenceCacheKeys(plan)).toEqual([]);
  });

  it('writes nothing when the plan is blocked', async () => {
    const snap = cloneSnapshot(PROD);
    snap.models.push({
      id: 'equinox',
      makeId: 'chevrolet',
      name: 'Equinox LT',
      sortOrder: 99,
    });
    const { prisma, writes } = fakeReferenceDb(snap);

    const err = await runVehicleReferenceSeed(prisma, { apply: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReferenceSeedAbort);
    expect((err as ReferenceSeedAbort).plan.conflicts).toEqual([
      expect.stringContaining('"equinox" is named "Equinox LT"'),
    ]);
    expect(writes).toEqual([]);
  });

  it('rolls everything back if leapmotor changed during the run', async () => {
    const { prisma, db, state } = fakeReferenceDb(PROD);
    db.vehicleMake.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      runVehicleReferenceSeed(prisma, { apply: true }),
    ).rejects.toThrow('changed during the run');
    expect(state()).toEqual(PROD);
  });

  it('rolls everything back if an existing row changed underneath the writes', async () => {
    const { prisma, db, state } = fakeReferenceDb(PROD);
    const create = db.vehicleModelRef.create.getMockImplementation()!;
    db.vehicleModelRef.create.mockImplementationOnce(
      (args: { data: ExistingModel }) => {
        state().models.find((m) => m.id === 'cobalt')!.sortOrder = 42;
        return create(args);
      },
    );
    await expect(
      runVehicleReferenceSeed(prisma, { apply: true }),
    ).rejects.toThrow('model "cobalt" changed unexpectedly');
    expect(state()).toEqual(PROD);
  });
});

describe('cache keys and report', () => {
  const plan = () => planVehicleReferenceSeed(VEHICLE_REFERENCE_DATASET, PROD);

  it('clears the makes list and the models list of every make it touched', () => {
    expect(referenceCacheKeys(plan())).toEqual([
      'cache:reference:makes',
      'cache:reference:models:chevrolet',
      'cache:reference:models:genesis',
      'cache:reference:models:leapmotor',
      'cache:reference:models:ravon',
      'cache:reference:models:skoda',
      'cache:reference:models:ssangyong',
    ]);
  });

  it('prints each kind of change in its own section', () => {
    const report = formatVehicleReferenceReport(plan(), {
      outcome: 'dry-run',
      target: 'db.local:5432/mator',
    });
    for (const line of [
      'Target: db.local:5432/mator',
      'Already present, unchanged (0 makes, 0 models)',
      'New makes (4): created active, not "coming soon"',
      "New models (17): appended after each make's existing models",
      'Explicit make-state changes (1)',
      'Conflicts needing a manual migration (0): BLOCKING',
      'Errors (0): BLOCKING',
      'Known issues left for separate migrations',
      'Preserved: 11 makes and 47 models outside the dataset are never written.',
      'Result: dry-run OK',
    ]) {
      expect(report).toContain(line);
    }
    expect(report).toContain('~ leapmotor        is_active true → false');
  });

  it('says BLOCKED when the plan cannot be applied', () => {
    const blocked = planVehicleReferenceSeed(
      {
        makes: [],
        models: [
          { id: 'matiz', makeId: 'chevrolet', name: 'Matiz', evidence: 'test' },
        ],
        makeStateChanges: [],
      },
      PROD,
    );
    expect(
      formatVehicleReferenceReport(blocked, {
        outcome: 'blocked',
        target: 't',
      }),
    ).toContain('Result: BLOCKED. Nothing was written.');
  });
});
