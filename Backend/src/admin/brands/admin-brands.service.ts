import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, AdminAuditEntity, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../auth/admin-audit.service';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { clampLimit } from '../../common/pagination.util';
import { CacheService } from '../../redis/cache.service';
import { RedisKeys } from '../../redis/redis.keys';
import {
  ADMIN_BRAND_LIST_SELECT,
  ADMIN_MODEL_SELECT,
  presentAdminBrandDetail,
  presentAdminBrandRow,
  presentAdminModelRow,
} from './admin-brands.presenter';
import { CreateAdminBrandDto } from './dto/create-admin-brand.dto';
import { CreateAdminModelDto } from './dto/create-admin-model.dto';
import { ListAdminBrandsQueryDto } from './dto/list-admin-brands.query.dto';
import { UpdateAdminBrandDto } from './dto/update-admin-brand.dto';
import { UpdateAdminModelDto } from './dto/update-admin-model.dto';

const DEFAULT_ADMIN_BRAND_LIMIT = 20;
const MAX_ADMIN_BRAND_LIMIT = 100;

// Prisma error codes we translate into HTTP semantics.
const PRISMA_UNIQUE_VIOLATION = 'P2002';
const PRISMA_FK_VIOLATION = 'P2003';

/**
 * Admin/operator brands + models console. Backs /v1/admin/brands and
 * /v1/admin/models over the EXISTING buyer-facing reference catalog
 * (VehicleMake / VehicleModelRef) — the very rows the mobile app reads via
 * GET /v1/reference/makes and /models. An edit here is therefore visible to the
 * app as soon as the reference cache is busted, which every mutation does.
 *
 * Two thin controllers (brands, models) share this one service because Nest
 * needs distinct controller base paths but the CRUD is one domain.
 */
@Injectable()
export class AdminBrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(query: ListAdminBrandsQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(
      query.limit,
      DEFAULT_ADMIN_BRAND_LIMIT,
      MAX_ADMIN_BRAND_LIMIT,
    );
    const sortField = query.sort ?? 'name';
    const direction = query.order ?? 'asc';

    const where: Prisma.VehicleMakeWhereInput = {};
    const term = query.search?.trim();
    if (term) where.name = { contains: term, mode: 'insensitive' };

    // The secondary `id` key makes the order total, so a page can never repeat
    // or skip a brand sharing a sort value with another.
    const orderBy: Prisma.VehicleMakeOrderByWithRelationInput[] =
      sortField === 'modelsCount'
        ? [{ models: { _count: direction } }, { id: 'asc' }]
        : [{ [sortField]: direction }, { id: 'asc' }];

    const [brands, totalItems] = await this.prisma.$transaction([
      this.prisma.vehicleMake.findMany({
        where,
        select: ADMIN_BRAND_LIST_SELECT,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.vehicleMake.count({ where }),
    ]);

    return {
      success: true,
      data: brands.map(presentAdminBrandRow),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  async getOne(id: string) {
    const brand = await this.prisma.vehicleMake.findUnique({
      where: { id },
      select: ADMIN_BRAND_LIST_SELECT,
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const models = await this.prisma.vehicleModelRef.findMany({
      where: { makeId: id },
      select: ADMIN_MODEL_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    return { success: true, data: presentAdminBrandDetail(brand, models) };
  }

  async create(dto: CreateAdminBrandDto) {
    const name = dto.name.trim();
    const id = await this.uniqueBrandId(dto.id?.trim() || slugify(name));
    const sortOrder = await this.nextBrandSortOrder();

    const brand = await this.withUniqueGuard('brand', () =>
      this.prisma.vehicleMake.create({
        data: {
          id,
          name,
          logoUrl: dto.logoUrl ?? null,
          country: dto.country ?? null,
          isActive: dto.isActive ?? true,
          comingSoon: dto.comingSoon ?? false,
          sortOrder,
        },
        select: ADMIN_BRAND_LIST_SELECT,
      }),
    );

    await this.bustMakes();
    return { success: true, data: presentAdminBrandRow(brand) };
  }

  async update(id: string, dto: UpdateAdminBrandDto) {
    await this.requireBrand(id);

    const data: Prisma.VehicleMakeUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.logoUrl !== undefined) data.logoUrl = dto.logoUrl ?? null;
    if (dto.country !== undefined) data.country = dto.country ?? null;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.comingSoon !== undefined) data.comingSoon = dto.comingSoon;

    const brand = await this.withUniqueGuard('brand', () =>
      this.prisma.vehicleMake.update({
        where: { id },
        data,
        select: ADMIN_BRAND_LIST_SELECT,
      }),
    );

    // Name/active/logo all feed the app's makes list, so bust it.
    await this.bustMakes();
    return { success: true, data: presentAdminBrandRow(brand) };
  }

  /**
   * What deleting a brand would take with it, so the console can say so first.
   * Fitment bindings are operator work: each one was checked and placed by hand, and
   * they go silently through the cascade.
   */
  async deletePreview(id: string) {
    await this.requireBrand(id);
    const [models, fitmentBindings, vehicles] = await Promise.all([
      this.prisma.vehicleModelRef.count({ where: { makeId: id } }),
      this.prisma.fitmentBinding.count({
        where: { vehicleModel: { makeId: id } },
      }),
      this.prisma.vehicle.count({ where: { makeId: id } }),
    ]);
    return { success: true, data: { models, fitmentBindings, vehicles } };
  }

  /** What deleting a model would take with it. */
  async modelDeletePreview(id: string) {
    const existing = await this.prisma.vehicleModelRef.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Model not found');
    const [fitmentBindings, vehicles] = await Promise.all([
      this.prisma.fitmentBinding.count({ where: { vehicleModelId: id } }),
      this.prisma.vehicle.count({ where: { modelId: id } }),
    ]);
    return { success: true, data: { fitmentBindings, vehicles } };
  }

  /**
   * Delete a brand. If fitment bindings would go with it, the caller must state how
   * many it accepts losing (`acceptedFitmentLoss`, from the preview): a 409 otherwise,
   * and also when the number has changed since.
   */
  async remove(
    id: string,
    acceptedFitmentLoss?: number,
    ctx: AdminAuditContext = {},
  ) {
    const brand = await this.prisma.vehicleMake.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    try {
      // Models cascade via the existing FK; a garage Vehicle referencing the
      // make blocks the delete with P2003.
      await this.prisma.$transaction(async (tx) => {
        const fitmentBindings = await tx.fitmentBinding.count({
          where: { vehicleModel: { makeId: id } },
        });
        assertFitmentLossAccepted(fitmentBindings, acceptedFitmentLoss);
        await tx.vehicleMake.delete({ where: { id } });
        await this.audit.record(
          {
            action: AdminAuditAction.BRAND_DELETED,
            actor: ctx.actor,
            actorLabel: ctx.actorLabel,
            target: {
              entity: AdminAuditEntity.BRAND,
              id,
              name: brand.name,
            },
            previousValues: { fitmentBindings },
            newValues: { deleted: true },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          },
          tx,
        );
      });
    } catch (err) {
      if (isPrismaError(err, PRISMA_FK_VIOLATION)) {
        throw new ConflictException(
          'Cannot delete: vehicles reference this brand',
        );
      }
      throw err;
    }

    // Deleting the make removes it AND its models from the app catalog.
    await this.bustMakes();
    await this.bustModels(id);
    return { success: true, data: { id } };
  }

  async createModel(brandId: string, dto: CreateAdminModelDto) {
    await this.requireBrand(brandId);

    const name = dto.name.trim();
    const id = await this.uniqueModelId(
      brandId,
      dto.id?.trim() || slugify(name),
    );
    const sortOrder = await this.nextModelSortOrder(brandId);

    const model = await this.withUniqueGuard('model', () =>
      this.prisma.vehicleModelRef.create({
        data: {
          id,
          makeId: brandId,
          name,
          yearFrom: dto.yearFrom ?? null,
          yearTo: dto.yearTo ?? null,
          bodyType: dto.bodyType ?? null,
          sortOrder,
        },
        select: ADMIN_MODEL_SELECT,
      }),
    );

    await this.bustMakes();
    await this.bustModels(brandId);
    return { success: true, data: presentAdminModelRow(model) };
  }

  async updateModel(id: string, dto: UpdateAdminModelDto) {
    const existing = await this.prisma.vehicleModelRef.findUnique({
      where: { id },
      select: { id: true, makeId: true },
    });
    if (!existing) throw new NotFoundException('Model not found');

    const data: Prisma.VehicleModelRefUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.yearFrom !== undefined) data.yearFrom = dto.yearFrom ?? null;
    if (dto.yearTo !== undefined) data.yearTo = dto.yearTo ?? null;
    if (dto.bodyType !== undefined) data.bodyType = dto.bodyType ?? null;

    const model = await this.withUniqueGuard('model', () =>
      this.prisma.vehicleModelRef.update({
        where: { id },
        data,
        select: ADMIN_MODEL_SELECT,
      }),
    );

    await this.bustModels(existing.makeId);
    return { success: true, data: presentAdminModelRow(model) };
  }

  /** Delete a model, under the same fitment rule as {@link remove}. */
  async removeModel(
    id: string,
    acceptedFitmentLoss?: number,
    ctx: AdminAuditContext = {},
  ) {
    const existing = await this.prisma.vehicleModelRef.findUnique({
      where: { id },
      select: { id: true, makeId: true, name: true },
    });
    if (!existing) throw new NotFoundException('Model not found');

    try {
      await this.prisma.$transaction(async (tx) => {
        const fitmentBindings = await tx.fitmentBinding.count({
          where: { vehicleModelId: id },
        });
        assertFitmentLossAccepted(fitmentBindings, acceptedFitmentLoss);
        await tx.vehicleModelRef.delete({ where: { id } });
        await this.audit.record(
          {
            action: AdminAuditAction.MODEL_DELETED,
            actor: ctx.actor,
            actorLabel: ctx.actorLabel,
            target: {
              entity: AdminAuditEntity.VEHICLE_MODEL,
              id,
              name: existing.name,
            },
            previousValues: { fitmentBindings, makeId: existing.makeId },
            newValues: { deleted: true },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          },
          tx,
        );
      });
    } catch (err) {
      if (isPrismaError(err, PRISMA_FK_VIOLATION)) {
        throw new ConflictException(
          'Cannot delete: vehicles reference this model',
        );
      }
      throw err;
    }

    await this.bustMakes();
    await this.bustModels(existing.makeId);
    return { success: true, data: { id } };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Load a brand or 404, returning nothing (existence check only). */
  private async requireBrand(id: string): Promise<void> {
    const brand = await this.prisma.vehicleMake.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
  }

  /** Next sortOrder for a new brand: one past the current max (0 when empty). */
  private async nextBrandSortOrder(): Promise<number> {
    const max = await this.prisma.vehicleMake.aggregate({
      _max: { sortOrder: true },
    });
    return (max._max.sortOrder ?? 0) + 1;
  }

  /** Next sortOrder for a new model within a make. */
  private async nextModelSortOrder(makeId: string): Promise<number> {
    const max = await this.prisma.vehicleModelRef.aggregate({
      where: { makeId },
      _max: { sortOrder: true },
    });
    return (max._max.sortOrder ?? 0) + 1;
  }

  /**
   * Ensure a brand slug is globally unique, appending -2, -3… on collision.
   * The final `withUniqueGuard` on the write still protects against a race, so
   * this is a best-effort friendly slug, not the correctness guarantee.
   */
  private async uniqueBrandId(base: string): Promise<string> {
    const slug = base || 'brand';
    let candidate = slug;
    let n = 2;
    while (
      await this.prisma.vehicleMake.findUnique({
        where: { id: candidate },
        select: { id: true },
      })
    ) {
      candidate = `${slug}-${n++}`;
    }
    return candidate;
  }

  /** Ensure a model slug is unique WITHIN the make, appending -2, -3… on collision. */
  private async uniqueModelId(makeId: string, base: string): Promise<string> {
    const slug = base || 'model';
    let candidate = slug;
    let n = 2;
    while (
      await this.prisma.vehicleModelRef.findFirst({
        where: { makeId, id: candidate },
        select: { id: true },
      })
    ) {
      candidate = `${slug}-${n++}`;
    }
    return candidate;
  }

  /**
   * Run a write, translating a Prisma unique-constraint violation (P2002) into
   * a 409 with a resource-specific message. Applied to create AND update.
   */
  private async withUniqueGuard<T>(
    kind: 'brand' | 'model',
    op: () => Promise<T>,
  ): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (isPrismaError(err, PRISMA_UNIQUE_VIOLATION)) {
        throw new ConflictException(
          kind === 'brand'
            ? 'A brand with this name already exists'
            : 'A model with this name already exists',
        );
      }
      throw err;
    }
  }

  /** Bust the app's makes list cache so an edit shows up immediately. */
  private async bustMakes(): Promise<void> {
    await this.cache.delete(RedisKeys.cacheReferenceMakes());
  }

  /** Bust a make's models list cache (models are cached per makeId). */
  private async bustModels(makeId: string): Promise<void> {
    await this.cache.delete(RedisKeys.cacheReferenceModels(makeId));
  }
}

/**
 * Slug from a name: lowercase, trim, non-alphanumerics → '-', collapse repeats,
 * strip leading/trailing '-'.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Refuse a delete that would lose fitment bindings the caller did not account for. */
function assertFitmentLossAccepted(
  fitmentBindings: number,
  accepted: number | undefined,
): void {
  if (fitmentBindings > 0 && accepted !== fitmentBindings) {
    throw new ConflictException({
      code: 'FITMENT_WOULD_BE_LOST',
      message: `This would delete ${fitmentBindings} fitment binding(s). Confirm that number to go ahead.`,
    });
  }
}

/** Narrow an unknown error to a Prisma known-request error with a given code. */
function isPrismaError(err: unknown, code: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
  );
}
