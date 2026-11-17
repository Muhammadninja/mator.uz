import { Injectable, Logger, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { Drivetrain, FuelType, NotificationType, Vehicle, VehicleTransmission } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import {
  VARIANT_SELECT,
  VEHICLE_INCLUDE,
  presentVehicle,
  vehicleNames,
} from './vehicle.presenter';
import { variantsForYear } from './vehicle-generation';
import { currentYearInUzbekistan, unsupportedYear } from './vehicle-year';
import { nameKey, normalizeVehicleName, parseVehicleSource, type VehicleSource } from './manual-vehicle';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NotificationsService } from '../../notifications/notifications.service';
import { VehicleImagesService } from '../vehicle-images/vehicle-images.service';
import { IMAGE_REVIEW_REASONS, type IdentityPlan } from '../vehicle-images/vehicle-image.identity';
import { AtomicBudget } from '../../redis/atomic-budget.service';
import { presentVehicleImage } from '../vehicle-images/vehicle-image.state';

/** New hand-entered car pictures one owner may start per day. */
const MANUAL_IMAGES_PER_USER_DAY = 3;
/** New hand-entered car pictures everyone together may start per day. */
const MANUAL_IMAGES_ALL_DAY = 100;
const DAY_SECONDS = 24 * 60 * 60;

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    private readonly images: VehicleImagesService,
    @Optional() private readonly budget?: AtomicBudget,
  ) {}

  async list(userId: string, opts: { includeDeleted: boolean; include3d: boolean }) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { userId, ...(opts.includeDeleted ? {} : { deletedAt: null }) },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
      include: VEHICLE_INCLUDE,
    });
    return {
      vehicles: vehicles.map((v) => presentVehicle(v, opts.include3d)),
      total: vehicles.length,
    };
  }

  async create(userId: string, dto: CreateVehicleDto) {
    const source = parseVehicleSource(dto);
    let sourceData: {
      makeId: string | null;
      modelId: string | null;
      customMakeName: string | null;
      customModelName: string | null;
    };
    let imagePlan: Awaited<ReturnType<VehicleImagesService['planFor']>> = null;
    let model3dAssetId: string | null = null;
    if (source.kind === 'catalog') {
      const catalog = await this.assertCatalogRefs(dto);
      // Identity and image plan from the catalog rows just read and the verified
      // vehicle image registry. Never blocks creation. A generic model is pictured
      // as the generation its year resolves to; an unresolved one is kept for review
      // and never requested.
      imagePlan = await this.images.planFor({
        year: dto.year,
        model: catalog.model,
        trim: catalog.trim,
        chosenVariantId: null,
      });
      model3dAssetId = dto.trim_id ? await this.resolve3dAsset(dto.trim_id) : null;
      sourceData = { makeId: source.makeId, modelId: source.modelId, customMakeName: null, customModelName: null };
    } else {
      // No catalog row: no trim/engine/3D. The picture comes from an unverified
      // identity under custom: ids, generated from the typed names and reviewed.
      const makeName = await this.assertManualRefs(source, dto.year);
      imagePlan = await this.manualImagePlan(userId, {
        year: dto.year,
        makeId: source.makeId,
        makeName,
        modelName: source.customModelName,
      });
      sourceData = {
        makeId: source.makeId,
        modelId: null,
        customMakeName: source.customMakeName,
        customModelName: source.customModelName,
      };
    }

    // First vehicle is always primary; otherwise honor the requested flag.
    const existingCount = await this.prisma.vehicle.count({ where: { userId, deletedAt: null } });
    const makePrimary = dto.is_primary === true || existingCount === 0;

    const vehicleId = prefixedId(IdPrefix.VEHICLE);
    const committed = await this.prisma.$transaction(async (tx) => {
      if (makePrimary) {
        await tx.vehicle.updateMany({
          where: { userId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      // Transactional outbox: the image request commits with the vehicle or not at all.
      const image = await this.images.stage(tx, vehicleId, imagePlan);
      const row = await tx.vehicle.create({
        data: {
          id: vehicleId,
          userId,
          isPrimary: makePrimary,
          nickname: dto.nickname,
          ...sourceData,
          year: dto.year,
          trimId: dto.trim_id,
          engineId: dto.engine_id,
          transmission: this.toEnum(VehicleTransmission, dto.transmission),
          drivetrain: this.toEnum(Drivetrain, dto.drivetrain),
          colorHex: dto.color_hex,
          vin: dto.vin,
          licensePlate: dto.license_plate,
          registrationRegionCode: dto.registration_region_code,
          mileageKm: dto.mileage_km,
          fuelType: this.toEnum(FuelType, dto.fuel_type),
          model3dAssetId,
          ...image.data,
        },
        include: VEHICLE_INCLUDE,
      });
      return { created: row, imageOutboxId: image.outboxId };
    });
    const { created, imageOutboxId } = committed;
    this.images.kick(imageOutboxId);

    const vehicle = presentVehicle(created, true);
    this.realtime.emitGarageEvent(userId, 'vehicle.created', vehicle);
    return vehicle;
  }

  /** Fetch a single owned vehicle (compatibility route GET /:id). */
  async get(userId: string, vehicleId: string) {
    await this.assertOwned(userId, vehicleId);
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: VEHICLE_INCLUDE,
    });
    return presentVehicle(vehicle!, true);
  }

  /**
   * GET /:id/image: the vehicle's image state, refreshed from the pipeline when
   * that is due (short timeout; a pipeline failure returns the stored state).
   */
  async getImage(userId: string, vehicleId: string) {
    const owned = await this.assertOwned(userId, vehicleId);
    await this.images.refresh(owned.imageIdentityKey);
    const row = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        imageReviewReason: true,
        imageIdentity: {
          select: {
            status: true,
            reason: true,
            imageUrl: true,
            imageVersion: true,
            imageLicense: true,
            imageLicenseUrl: true,
            imageAuthor: true,
            imageAttribution: true,
            imageSourcePage: true,
            imageSourceTitle: true,
            imageModifications: true,
            catalogAssetKey: true,
            pipelineStatus: true,
            identity: true,
          },
        },
      },
    });
    return {
      vehicle_id: vehicleId,
      vehicle_image: presentVehicleImage(row ?? {}),
    };
  }

  /**
   * Dedicated set-primary route (POST /:id/set-primary). Equivalent to
   * `update(... { is_primary: true })` but a first-class endpoint per the
   * frontend contract. Emits both the existing `vehicle.updated` event and the
   * `primary_vehicle_changed` alias.
   */
  async setPrimary(userId: string, vehicleId: string) {
    await this.assertOwned(userId, vehicleId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.vehicle.updateMany({
        where: { userId, isPrimary: true, id: { not: vehicleId } },
        data: { isPrimary: false },
      });
      return tx.vehicle.update({
        where: { id: vehicleId },
        data: { isPrimary: true },
        include: VEHICLE_INCLUDE,
      });
    });

    const vehicle = presentVehicle(updated, true);
    this.realtime.emitGarageEvent(userId, 'vehicle.updated', vehicle);
    this.realtime.emitGarageEvent(userId, 'primary_vehicle_changed', vehicle);
    return vehicle;
  }

  async update(userId: string, vehicleId: string, dto: UpdateVehicleDto) {
    const owned = await this.assertOwned(userId, vehicleId);
    const renamed = this.planManualRename(owned, dto);
    // A renamed manual vehicle is a different car to picture: re-plan its image.
    const renamePlan =
      renamed.customMakeName !== undefined || renamed.customModelName !== undefined
        ? await this.manualImagePlan(userId, {
            year: owned.year,
            makeId: owned.makeId,
            makeName: owned.makeId
              ? (await this.prisma.vehicleMake.findUnique({ where: { id: owned.makeId } }))?.name ?? ''
              : renamed.customMakeName ?? owned.customMakeName ?? '',
            modelName: renamed.customModelName ?? owned.customModelName ?? '',
          })
        : null;
    const variant =
      dto.variant_model_id !== undefined
        ? await this.planVariantPick(owned, dto.variant_model_id)
        : null;

    let imageOutboxId: string | null = null;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.is_primary === true) {
        await tx.vehicle.updateMany({
          where: { userId, isPrimary: true, id: { not: vehicleId } },
          data: { isPrimary: false },
        });
      }
      // A generation pick re-plans the identity and picture with the vehicle's
      // write. Without a plan (the catalog could not be read), the stored
      // identity and image state are left as they are.
      let imageData = {};
      const plan = variant?.plan ?? renamePlan;
      if (plan) {
        const image = await this.images.stage(tx, vehicleId, plan);
        imageOutboxId = image.outboxId;
        imageData = image.data;
      }
      return tx.vehicle.update({
        where: { id: vehicleId },
        data: {
          nickname: dto.nickname,
          mileageKm: dto.mileage_km,
          isPrimary: dto.is_primary,
          registrationRegionCode: dto.registration_region_code,
          colorHex: dto.color_hex,
          licensePlate: dto.license_plate,
          vin: dto.vin,
          ...renamed,
          ...(variant ? { variantModelId: variant.variantModelId } : {}),
          ...imageData,
        },
        include: VEHICLE_INCLUDE,
      });
    });
    this.images.kick(imageOutboxId);

    const vehicle = presentVehicle(updated, true);
    this.realtime.emitGarageEvent(userId, 'vehicle.updated', vehicle);
    if (dto.is_primary === true) {
      this.realtime.emitGarageEvent(userId, 'primary_vehicle_changed', vehicle);
    }
    await this.notifications.emit(userId, {
      type: NotificationType.VEHICLE_STATUS_UPDATED,
      title: 'Avtomobil maʼlumotlari yangilandi',
      body: `${updated.nickname ?? Object.values(vehicleNames(updated)).join(' ').trim()} maʼlumotlari yangilandi.`,
      data: { vehicle_id: updated.id },
      deeplinkPath: `/(tabs)/(garage)/vehicle/${updated.id}`,
    });
    return vehicle;
  }

  /** Soft-delete; if the removed vehicle was primary, promote the newest remaining one. */
  async remove(userId: string, vehicleId: string) {
    const existing = await this.assertOwned(userId, vehicleId);

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id: vehicleId },
        data: { deletedAt: new Date(), isPrimary: false },
      });
      if (existing.isPrimary) {
        const next = await tx.vehicle.findFirst({
          where: { userId, deletedAt: null, id: { not: vehicleId } },
          orderBy: { createdAt: 'desc' },
        });
        if (next) {
          await tx.vehicle.update({ where: { id: next.id }, data: { isPrimary: true } });
        }
      }
    });

    this.realtime.emitGarageEvent(userId, 'vehicle.deleted', { id: vehicleId });
    return { id: vehicleId, deleted: true };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private async assertOwned(userId: string, vehicleId: string) {
    const v = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!v || v.userId !== userId || v.deletedAt) {
      throw new NotFoundException('Vehicle not found');
    }
    return v;
  }

  /**
   * PATCH `variant_model_id`: the owner's pick of a generation for a generic-model
   * vehicle. Accepted only among the generations its year leaves open, and never
   * over a picked trim (more precise, so it wins). Null clears the pick.
   */
  private async planVariantPick(
    vehicle: Vehicle,
    variantModelId: string | null,
  ) {
    const model = vehicle.modelId
      ? await this.prisma.vehicleModelRef.findUnique({
          where: { id: vehicle.modelId },
          include: { variants: { select: VARIANT_SELECT } },
        })
      : null;
    if (!model || model.variants.length === 0 || vehicle.trimId) {
      throw new BadRequestException('This vehicle has no generation to choose');
    }
    const options = variantsForYear(model.variants, vehicle.year);
    const allowed =
      options.length > 1 && options.some((v) => v.id === variantModelId);
    if (variantModelId !== null && !allowed) {
      throw new BadRequestException(
        'variant_model_id is not a generation option for this vehicle',
      );
    }
    const plan = await this.images.planFor({
      year: vehicle.year,
      model,
      trim: null,
      chosenVariantId: variantModelId,
    });
    return { variantModelId, plan };
  }

  /**
   * A manual vehicle: its catalog make (if any) exists and is offered, the year
   * is not in the future, and the typed names do not duplicate an offered
   * catalog row (the owner should pick that row instead, with its exact fit).
   * Only active makes count: a hidden make cannot be picked, so typing it is
   * the owner's only way to add such a car. Returns the make's display name.
   */
  private async assertManualRefs(
    source: Extract<VehicleSource, { kind: 'manual' }>,
    year: number,
  ) {
    const latest = currentYearInUzbekistan();
    if (year > latest) {
      throw new BadRequestException({
        code: 'VEHICLE_YEAR_IN_FUTURE',
        message: `A manually entered vehicle cannot be from after ${latest}.`,
        details: { year, year_to: latest },
      });
    }
    const makeId = source.makeId;
    let makeName = source.customMakeName ?? '';
    if (makeId) {
      const make = await this.prisma.vehicleMake.findUnique({ where: { id: makeId } });
      if (!make || !make.isActive) throw new BadRequestException('Unknown make_id');
      makeName = make.name;
    } else {
      const makes = await this.prisma.vehicleMake.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });
      const match = makes.find((m) => nameKey(m.name) === nameKey(source.customMakeName!));
      if (match) {
        // The make is listed: the model may be too; otherwise point the app at
        // the listed make so the owner types only the model.
        const model = await this.findCatalogModel(match.id, source.customModelName);
        throw new BadRequestException({
          code: 'VEHICLE_IN_CATALOG',
          message: `${match.name} is in the catalog; choose it from the list.`,
          details: { make_id: match.id, model_id: model?.id ?? null },
        });
      }
      return makeName;
    }
    const model = await this.findCatalogModel(makeId, source.customModelName);
    if (model) {
      throw new BadRequestException({
        code: 'VEHICLE_IN_CATALOG',
        message: `${model.name} is in the catalog; choose it from the list.`,
        details: { make_id: makeId, model_id: model.id },
      });
    }
    return makeName;
  }

  /** The make's offered catalog model with this name (case/space-insensitive), if any. */
  private async findCatalogModel(makeId: string, name: string) {
    const models = await this.prisma.vehicleModelRef.findMany({
      where: { makeId, variantOfModelId: null },
      select: { id: true, name: true },
    });
    return models.find((m) => nameKey(m.name) === nameKey(name)) ?? null;
  }

  /**
   * PATCH custom_make_name / custom_model_name: renames a manual vehicle only.
   * A catalog vehicle (or a manual one with a catalog make, for the make name)
   * refuses them, so a row never mixes catalog ids with typed names.
   */
  /**
   * The picture plan for a hand-entered vehicle. Typed names are open text, and
   * with generation first every new one is a paid image generation, so a name no
   * owner has typed before takes one unit of the owner's daily allowance and of
   * everyone's. Past either (or when Redis can't say) the vehicle still saves,
   * on the placeholder. A name already pictured or requested costs nothing.
   */
  private async manualImagePlan(
    userId: string,
    input: Parameters<VehicleImagesService['planManual']>[0],
  ): Promise<IdentityPlan | null> {
    const plan = this.images.planManual(input);
    if (!plan || plan.kind !== 'request' || !this.budget) return plan;
    const known = await this.prisma.vehicleImageIdentity.findUnique({
      where: { identityKey: plan.identityKey },
      select: { identityKey: true },
    });
    if (known) return plan;
    try {
      const decision = await this.budget.reserve([
        { key: `vehicle-image:manual:user:${userId}`, limit: MANUAL_IMAGES_PER_USER_DAY, windowSeconds: DAY_SECONDS },
        { key: 'vehicle-image:manual:all', limit: MANUAL_IMAGES_ALL_DAY, windowSeconds: DAY_SECONDS },
      ]);
      if (decision.allowed) return plan;
      this.logger.warn(`vehicle-image manual budget spent (${decision.refusedBy.startsWith('vehicle-image:manual:user') ? 'owner' : 'all'})`);
    } catch (err) {
      this.logger.warn(`vehicle-image manual budget unreadable: ${(err as Error)?.name ?? 'error'}`);
    }
    return { kind: 'review', reason: IMAGE_REVIEW_REASONS.MANUAL_IMAGE_BUDGET };
  }

  private planManualRename(vehicle: Vehicle, dto: UpdateVehicleDto) {
    const data: { customMakeName?: string; customModelName?: string } = {};
    if (dto.custom_model_name !== undefined) {
      if (vehicle.modelId !== null) {
        throw new BadRequestException({ code: 'VEHICLE_SOURCE_INVALID', message: 'Only a manual vehicle has a custom model name' });
      }
      data.customModelName = normalizeVehicleName(dto.custom_model_name, 'custom_model_name');
    }
    if (dto.custom_make_name !== undefined) {
      if (vehicle.modelId !== null || vehicle.makeId !== null) {
        throw new BadRequestException({ code: 'VEHICLE_SOURCE_INVALID', message: 'This vehicle has a catalog make' });
      }
      data.customMakeName = normalizeVehicleName(dto.custom_make_name, 'custom_make_name');
    }
    return data;
  }

  private async assertCatalogRefs(dto: CreateVehicleDto) {
    const model = await this.prisma.vehicleModelRef.findUnique({
      where: { id: dto.model_id! },
      include: { variants: { select: VARIANT_SELECT } },
    });
    if (!model || model.makeId !== dto.make_id) {
      throw new BadRequestException('Unknown or mismatched make_id/model_id');
    }
    // `year` is the build (production) year: see vehicle-year.ts.
    const range = unsupportedYear(model, dto.year);
    if (range) {
      throw new BadRequestException({
        code: 'VEHICLE_YEAR_UNSUPPORTED',
        message: `${model.name} is not available for ${dto.year}.`,
        details: { year: dto.year, ...range },
      });
    }
    let trim: { id: string; modelId: string; name: string } | null = null;
    if (dto.trim_id) {
      trim = await this.prisma.vehicleTrim.findUnique({ where: { id: dto.trim_id } });
      if (!trim || trim.modelId !== dto.model_id) {
        throw new BadRequestException('Unknown or mismatched trim_id');
      }
    }
    if (dto.engine_id) {
      const engine = await this.prisma.vehicleEngine.findUnique({ where: { id: dto.engine_id } });
      if (!engine) throw new BadRequestException('Unknown engine_id');
    }
    return { model, trim };
  }

  private async resolve3dAsset(trimId: string): Promise<string | null> {
    const asset = await this.prisma.vehicle3dAsset.findFirst({
      where: { trimId },
      orderBy: { version: 'desc' },
    });
    return asset?.id ?? null;
  }

  // Contract sends lowercase enum values; Prisma enums are the uppercase form.
  private toEnum<T extends Record<string, string>>(
    enumObj: T,
    value?: string,
  ): T[keyof T] | undefined {
    if (!value) return undefined;
    return enumObj[value.toUpperCase() as keyof T];
  }
}
