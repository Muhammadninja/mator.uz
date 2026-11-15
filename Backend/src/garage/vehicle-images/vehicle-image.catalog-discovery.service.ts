import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  VehicleImageCatalogDiscoveryRunStatus,
  VehicleImageCatalogDiscoveryStatus,
  VehicleImageCatalogDiscoveryTrigger,
  VehicleImageStatus,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { VehicleImageDeliveryService } from './vehicle-image.delivery.service';
import { VehicleImagesService } from './vehicle-images.service';
import type { IdentityPlan } from './vehicle-image.identity';
import type { VariantRow } from '../vehicles/vehicle-generation';
import { readVehicleImageConfig } from './vehicle-image.config';

const CATALOG_SELECT = {
  id: true,
  name: true,
  models: {
    where: { variantOfModelId: null },
    select: {
      id: true,
      makeId: true,
      name: true,
      yearFrom: true,
      yearTo: true,
      bodyType: true,
      variants: {
        select: {
          id: true,
          makeId: true,
          name: true,
          yearFrom: true,
          yearTo: true,
          bodyType: true,
        },
      },
    },
  },
} satisfies Prisma.VehicleMakeSelect;

type CatalogMake = Prisma.VehicleMakeGetPayload<{
  select: typeof CATALOG_SELECT;
}>;
type CatalogModel = CatalogMake['models'][number];
type CatalogVariant = CatalogModel['variants'][number];

type DiscoveryResult = {
  scanned: number;
  scheduled: number;
  existing: number;
  approved: number;
  reviewRequired: number;
  failed: number;
};

const emptyResult = (): DiscoveryResult => ({
  scanned: 0,
  scheduled: 0,
  existing: 0,
  approved: 0,
  reviewRequired: 0,
  failed: 0,
});

const safeErrorCode = (error: unknown): string => {
  const value =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : error instanceof Error
        ? error.name
        : 'discovery_error';
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : 'discovery_error';
};

const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const variantRow = (row: CatalogModel | CatalogVariant): VariantRow => ({
  id: row.id,
  makeId: row.makeId,
  name: row.name,
  bodyType: row.bodyType,
  yearFrom: row.yearFrom,
  yearTo: row.yearTo,
});

const rangesOverlap = (a: CatalogVariant, b: CatalogVariant): boolean =>
  a.yearFrom !== null &&
  a.yearTo !== null &&
  b.yearFrom !== null &&
  b.yearTo !== null &&
  a.yearFrom <= b.yearTo &&
  b.yearFrom <= a.yearTo;

const invalidRange = (row: {
  yearFrom: number | null;
  yearTo: number | null;
}): boolean =>
  row.yearFrom === null ||
  row.yearTo === null ||
  row.yearFrom < 1886 ||
  row.yearTo > 2200 ||
  row.yearFrom > row.yearTo;

/**
 * Polls the authoritative Backend model catalog and stages missing canonical
 * identities through the existing VehicleImageIdentity + outbox transaction.
 * It never invents generation, market or canonical IDs: incomplete/overlapping
 * catalog facts become durable review rows for an operator.
 */
@Injectable()
export class VehicleImageCatalogDiscoveryService {
  private readonly logger = new Logger(
    VehicleImageCatalogDiscoveryService.name,
  );
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly images: VehicleImagesService,
    private readonly delivery: VehicleImageDeliveryService,
    config: ConfigService,
  ) {
    this.enabled = readVehicleImageConfig((key) =>
      config.get(key),
    ).catalogDiscoveryEnabled;
  }

  async run(input: {
    trigger: VehicleImageCatalogDiscoveryTrigger;
  }): Promise<
    {
      runId: string;
      trigger: VehicleImageCatalogDiscoveryTrigger;
    } & DiscoveryResult
  > {
    if (!this.enabled)
      throw new ServiceUnavailableException(
        'Vehicle image catalog discovery is disabled.',
      );
    const runId = `vcd_${randomUUID()}`;
    await this.prisma.vehicleImageCatalogDiscoveryRun.create({
      data: { id: runId, trigger: input.trigger },
    });
    const result = emptyResult();
    try {
      const makes: CatalogMake[] = await this.prisma.vehicleMake.findMany({
        where: { isActive: true },
        select: CATALOG_SELECT,
        orderBy: { id: 'asc' },
      });
      for (const make of makes) {
        for (const model of make.models) {
          if (model.variants.length > 0) {
            for (const variant of model.variants) {
              const overlaps = model.variants.some(
                (other) =>
                  other.id !== variant.id && rangesOverlap(other, variant),
              );
              const reason =
                variant.makeId !== make.id
                  ? 'generation_make_mismatch'
                  : variant.yearFrom === null || variant.yearTo === null
                    ? 'generation_year_range_missing'
                    : invalidRange(variant)
                      ? 'generation_year_range_invalid'
                      : overlaps
                        ? 'generation_year_ranges_overlap'
                        : null;
              const row = variantRow(variant);
              const base = {
                ...variantRow(model),
                variants: model.variants.map(variantRow),
              };
              const plan = reason
                ? null
                : await this.images.planFor({
                    year: variant.yearFrom as number,
                    model: base,
                    trim: null,
                    chosenVariantId: variant.id,
                  });
              await this.processSubject(
                {
                  runId,
                  trigger: input.trigger,
                  makeId: make.id,
                  makeName: make.name,
                  model,
                  subject: row,
                  fingerprintSource: {
                    makeId: make.id,
                    makeName: make.name,
                    model,
                    variant,
                  },
                  plan,
                  reason,
                },
                result,
              );
            }
          } else {
            const row = variantRow(model);
            const reason =
              model.yearFrom === null || model.yearTo === null
                ? 'model_year_range_missing'
                : invalidRange(model)
                  ? 'model_year_range_invalid'
                  : null;
            const plan: IdentityPlan | null = reason
              ? null
              : await this.images.prepare({
                  year: model.yearFrom as number,
                  model: row,
                  trim: null,
                });
            await this.processSubject(
              {
                runId,
                trigger: input.trigger,
                makeId: make.id,
                makeName: make.name,
                model,
                subject: row,
                fingerprintSource: {
                  makeId: make.id,
                  makeName: make.name,
                  model,
                },
                plan,
                reason,
              },
              result,
            );
          }
        }
      }
      await this.prisma.vehicleImageCatalogDiscoveryRun.update({
        where: { id: runId },
        data: {
          status: VehicleImageCatalogDiscoveryRunStatus.COMPLETED,
          ...this.toCounts(result),
          completedAt: new Date(),
        },
      });
      return { runId, trigger: input.trigger, ...result };
    } catch (error) {
      const code = safeErrorCode(error);
      await this.prisma.vehicleImageCatalogDiscoveryRun
        .update({
          where: { id: runId },
          data: {
            status: VehicleImageCatalogDiscoveryRunStatus.FAILED,
            ...this.toCounts(result),
            completedAt: new Date(),
            lastError: code,
          },
        })
        .catch(() => undefined);
      this.logger.error(`catalog discovery failed run=${runId} code=${code}`);
      throw error;
    }
  }

  private async processSubject(
    input: {
      runId: string;
      trigger: VehicleImageCatalogDiscoveryTrigger;
      makeId: string;
      makeName: string;
      model: CatalogModel;
      subject: VariantRow;
      fingerprintSource: unknown;
      plan: IdentityPlan | null;
      reason: string | null;
    },
    result: DiscoveryResult,
  ): Promise<void> {
    result.scanned += 1;
    const isGeneration = input.subject.id !== input.model.id;
    const sourceKey = `${input.makeId}:${input.model.id}:${isGeneration ? `generation:${input.subject.id}` : 'model'}`;
    const sourceFingerprint = fingerprint(input.fingerprintSource);
    const upsert = async (
      status: VehicleImageCatalogDiscoveryStatus,
      reason: string | null,
      identityKey: string | null,
      error: string | null = null,
    ) =>
      this.prisma.vehicleImageCatalogDiscovery.upsert({
        where: { sourceKey },
        create: {
          sourceKey,
          makeId: input.makeId,
          modelId: input.model.id,
          generationId: isGeneration ? input.subject.id : null,
          sourceFingerprint,
          status,
          reason,
          identityKey,
          lastRunId: input.runId,
          lastError: error,
          lastScannedAt: new Date(),
        },
        update: {
          makeId: input.makeId,
          modelId: input.model.id,
          generationId: isGeneration ? input.subject.id : null,
          sourceFingerprint,
          status,
          reason,
          identityKey,
          lastRunId: input.runId,
          lastError: error,
          lastScannedAt: new Date(),
        },
      });

    try {
      if (input.reason) {
        await upsert(
          VehicleImageCatalogDiscoveryStatus.REVIEW_REQUIRED,
          input.reason,
          null,
        );
        result.reviewRequired += 1;
        return;
      }
      if (!input.plan || input.plan.kind === 'review') {
        await upsert(
          VehicleImageCatalogDiscoveryStatus.REVIEW_REQUIRED,
          input.plan?.kind === 'review'
            ? input.plan.reason
            : 'catalog_identity_unresolved',
          null,
        );
        result.reviewRequired += 1;
        return;
      }
      const staged = await this.prisma.$transaction((tx) =>
        this.images.stage(tx, `catalog:${sourceKey}`, input.plan!),
      );
      this.images.kick(staged.outboxId);
      const identity = await this.prisma.vehicleImageIdentity.findUnique({
        where: { identityKey: input.plan.identityKey },
        select: { status: true, catalogAssetKey: true },
      });
      const status =
        identity?.status === VehicleImageStatus.APPROVED
          ? VehicleImageCatalogDiscoveryStatus.APPROVED
          : staged.outboxId
            ? VehicleImageCatalogDiscoveryStatus.SCHEDULED
            : VehicleImageCatalogDiscoveryStatus.EXISTING;
      await upsert(status, null, input.plan.identityKey);
      if (status === VehicleImageCatalogDiscoveryStatus.APPROVED)
        result.approved += 1;
      else if (status === VehicleImageCatalogDiscoveryStatus.SCHEDULED)
        result.scheduled += 1;
      else result.existing += 1;
    } catch (error) {
      const code = safeErrorCode(error);
      await upsert(
        VehicleImageCatalogDiscoveryStatus.FAILED,
        null,
        null,
        code,
      ).catch(() => undefined);
      result.failed += 1;
      this.logger.warn(
        `catalog discovery subject failed key=${fingerprint(sourceKey).slice(0, 12)} code=${code}`,
      );
    }
  }

  private toCounts(result: DiscoveryResult) {
    return {
      scanned: result.scanned,
      scheduled: result.scheduled,
      existing: result.existing,
      approved: result.approved,
      reviewRequired: result.reviewRequired,
      failed: result.failed,
    };
  }

  async status() {
    const [counts, latestRuns, reviewRequired, failures] = await Promise.all([
      this.prisma.vehicleImageCatalogDiscovery.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.vehicleImageCatalogDiscoveryRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: 10,
      }),
      this.prisma.vehicleImageCatalogDiscovery.findMany({
        where: { status: VehicleImageCatalogDiscoveryStatus.REVIEW_REQUIRED },
        orderBy: { lastScannedAt: 'desc' },
        take: 100,
        select: {
          sourceKey: true,
          makeId: true,
          modelId: true,
          generationId: true,
          reason: true,
          lastScannedAt: true,
        },
      }),
      this.prisma.vehicleImageCatalogDiscovery.findMany({
        where: { status: VehicleImageCatalogDiscoveryStatus.FAILED },
        orderBy: { lastScannedAt: 'desc' },
        take: 100,
        select: {
          sourceKey: true,
          makeId: true,
          modelId: true,
          generationId: true,
          lastError: true,
          lastScannedAt: true,
        },
      }),
    ]);
    return {
      enabled: this.enabled,
      counts: Object.fromEntries(
        counts.map((row) => [row.status, row._count._all]),
      ),
      latestRuns,
      reviewRequired,
      failures,
    };
  }
}
