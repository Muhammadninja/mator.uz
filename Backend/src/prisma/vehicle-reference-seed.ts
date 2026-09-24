import { Prisma, PrismaClient } from '@prisma/client';
import { RedisKeys } from '../redis/redis.keys';
import {
  isBlocked,
  isNoop,
  planVehicleReferenceSeed,
  ReferenceDataset,
  ReferencePlan,
  ReferenceSnapshot,
  VEHICLE_REFERENCE_DATASET,
} from './vehicle-reference-plan';

/**
 * G-2 vehicle reference seed: adds the makes and models the Garage picker is
 * missing, without disturbing what is already live.
 *
 * ── Design rules (planning lives in vehicle-reference-plan.ts) ──────────────
 *  • PLAN FIRST — the whole run is computed from one read of the reference
 *    tables before anything is written, and the dry-run prints exactly that.
 *  • ADDITIVE — a missing row is created; an existing row is never renamed,
 *    re-sorted, moved to another make, re-keyed or deleted. There is no upsert
 *    `update` branch and no delete anywhere in this file.
 *  • IDEMPOTENT — a row already present exactly as the dataset says is
 *    "unchanged", so a second run plans nothing.
 *  • FAIL CLOSED — a dataset problem or an id owned by another make is an error,
 *    and existing data that disagrees with the dataset is a conflict. Either one
 *    blocks the run before any write.
 *  • ONE TRANSACTION — the apply re-plans inside a serializable transaction,
 *    writes, then re-reads and checks that every pre-existing row is unchanged
 *    (apart from the planned is_active flips). Any surprise rolls it all back.
 *  • EXPLICIT VISIBILITY — `is_active` changes only for makes named in
 *    REFERENCE_MAKE_STATE_CHANGES; empty makes are not disabled by rule.
 */

type ReferenceReader = Pick<PrismaClient, 'vehicleMake' | 'vehicleModelRef'>;

export async function loadReferenceSnapshot(
  db: ReferenceReader,
): Promise<ReferenceSnapshot> {
  const [makes, models] = await Promise.all([
    db.vehicleMake.findMany({
      select: {
        id: true,
        name: true,
        isActive: true,
        comingSoon: true,
        sortOrder: true,
      },
      orderBy: { id: 'asc' },
    }),
    db.vehicleModelRef.findMany({
      select: { id: true, makeId: true, name: true, sortOrder: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  return { makes, models };
}

/**
 * After the writes: every pre-existing row must be exactly as before, except the
 * planned is_active flips, and the new rows must be exactly as planned.
 */
export function verifyApplied(
  before: ReferenceSnapshot,
  after: ReferenceSnapshot,
  plan: ReferencePlan,
): string[] {
  const problems: string[] = [];
  const afterMakes = new Map(after.makes.map((m) => [m.id, m]));
  const afterModels = new Map(after.models.map((m) => [m.id, m]));
  const flips = new Map(plan.stateChanges.map((c) => [c.makeId, c.to]));

  for (const m of before.makes) {
    const now = afterMakes.get(m.id);
    const isActive = flips.get(m.id) ?? m.isActive;
    if (
      !now ||
      now.name !== m.name ||
      now.sortOrder !== m.sortOrder ||
      now.comingSoon !== m.comingSoon ||
      now.isActive !== isActive
    ) {
      problems.push(`make "${m.id}" changed unexpectedly`);
    }
  }
  for (const m of before.models) {
    const now = afterModels.get(m.id);
    if (
      !now ||
      now.makeId !== m.makeId ||
      now.name !== m.name ||
      now.sortOrder !== m.sortOrder
    ) {
      problems.push(`model "${m.id}" changed unexpectedly`);
    }
  }
  for (const m of plan.newMakes) {
    const now = afterMakes.get(m.id);
    if (
      !now ||
      now.name !== m.name ||
      now.sortOrder !== m.sortOrder ||
      !now.isActive ||
      now.comingSoon
    ) {
      problems.push(`new make "${m.id}" was not written as planned`);
    }
  }
  for (const m of plan.newModels) {
    const now = afterModels.get(m.id);
    if (
      !now ||
      now.makeId !== m.makeId ||
      now.name !== m.name ||
      now.sortOrder !== m.sortOrder
    ) {
      problems.push(`new model "${m.id}" was not written as planned`);
    }
  }
  if (after.makes.length !== before.makes.length + plan.newMakes.length) {
    problems.push(
      `expected ${before.makes.length + plan.newMakes.length} makes, found ${after.makes.length}`,
    );
  }
  if (after.models.length !== before.models.length + plan.newModels.length) {
    problems.push(
      `expected ${before.models.length + plan.newModels.length} models, found ${after.models.length}`,
    );
  }
  return problems;
}

/** Thrown inside the apply transaction so nothing is written. */
export class ReferenceSeedAbort extends Error {
  constructor(
    message: string,
    readonly plan: ReferencePlan,
  ) {
    super(message);
  }
}

export interface ReferenceSeedResult {
  plan: ReferencePlan;
  applied: boolean;
}

/**
 * Dry-run (default): read, plan, return. Apply: re-read and re-plan inside one
 * serializable transaction, refuse a blocked plan, write, verify, commit.
 */
export async function runVehicleReferenceSeed(
  prisma: PrismaClient,
  opts: { apply: boolean; dataset?: ReferenceDataset },
): Promise<ReferenceSeedResult> {
  const dataset = opts.dataset ?? VEHICLE_REFERENCE_DATASET;
  if (!opts.apply) {
    return {
      plan: planVehicleReferenceSeed(
        dataset,
        await loadReferenceSnapshot(prisma),
      ),
      applied: false,
    };
  }

  const plan = await prisma.$transaction(
    async (tx) => {
      const before = await loadReferenceSnapshot(tx);
      const planned = planVehicleReferenceSeed(dataset, before);
      if (isBlocked(planned)) {
        throw new ReferenceSeedAbort(
          'blocked by conflicts or errors; nothing written',
          planned,
        );
      }

      for (const m of planned.newMakes) {
        await tx.vehicleMake.create({
          data: {
            id: m.id,
            name: m.name,
            sortOrder: m.sortOrder,
            isActive: true,
            comingSoon: false,
          },
        });
      }
      for (const m of planned.newModels) {
        await tx.vehicleModelRef.create({
          data: {
            id: m.id,
            makeId: m.makeId,
            name: m.name,
            sortOrder: m.sortOrder,
          },
        });
      }
      for (const c of planned.stateChanges) {
        // Guarded on the value the plan saw, so a concurrent edit fails the run.
        const { count } = await tx.vehicleMake.updateMany({
          where: { id: c.makeId, isActive: c.from },
          data: { isActive: c.to },
        });
        if (count !== 1) {
          throw new ReferenceSeedAbort(
            `make "${c.makeId}" changed during the run`,
            planned,
          );
        }
      }

      const problems = verifyApplied(
        before,
        await loadReferenceSnapshot(tx),
        planned,
      );
      if (problems.length > 0) {
        throw new ReferenceSeedAbort(
          `post-write check failed: ${problems.join('; ')}`,
          planned,
        );
      }
      return planned;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    },
  );
  return { plan, applied: !isNoop(plan) };
}

/** Reference API cache entries a plan invalidates (they otherwise live 24h). */
export function referenceCacheKeys(plan: ReferencePlan): string[] {
  if (isNoop(plan)) return [];
  const makeIds = new Set([
    ...plan.newMakes.map((m) => m.id),
    ...plan.newModels.map((m) => m.makeId),
    ...plan.stateChanges.map((c) => c.makeId),
  ]);
  return [
    RedisKeys.cacheReferenceMakes(),
    ...[...makeIds].sort().map((id) => RedisKeys.cacheReferenceModels(id)),
  ];
}
