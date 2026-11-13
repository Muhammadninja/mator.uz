import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Drivetrain, FuelType, NotificationType, Vehicle, VehicleTransmission } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import {
  VARIANT_SELECT,
  VEHICLE_INCLUDE,
  presentVehicle,
} from './vehicle.presenter';
import {
  imageSubject,
  resolveGeneration,
  variantsForYear,
  type VariantRow,
} from './vehicle-generation';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NotificationsService } from '../../notifications/notifications.service';
import { VehicleImagesService } from '../vehicle-images/vehicle-images.service';
import { presentVehicleImage } from '../vehicle-images/vehicle-image.state';
import type { IdentityPlan } from '../vehicle-images/vehicle-image.identity';

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    private readonly images: VehicleImagesService,
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
    const catalog = await this.assertCatalogRefs(dto);
    // Vehicle image identity from the catalog rows just read (null when the
    // integration is off). Never blocks creation. A generic model is pictured as
    // the generation its year resolves to; an unresolved one is not requested.
    const generation = resolveGeneration({
      year: dto.year,
      trimId: catalog.trim?.id ?? null,
      variants: catalog.model.variants,
      chosenVariantId: null,
    });
    const imagePlan = await this.prepareImage(
      dto.year,
      catalog.model,
      catalog.trim,
      generation,
    );
    const model3dAssetId = dto.trim_id ? await this.resolve3dAsset(dto.trim_id) : null;

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
          makeId: dto.make_id,
          modelId: dto.model_id,
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
            catalogAssetKey: true,
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
      // A generation pick re-plans the picture with the vehicle's write. With the
      // integration off (no plan), the stored image state is left as it is.
      let imageData = {};
      if (variant?.plan) {
        const image = await this.images.stage(tx, vehicleId, variant.plan);
        imageOutboxId = image.outboxId;
        imageData = {
          imageIdentityKey: image.data.imageIdentityKey ?? null,
          imageReviewReason: image.data.imageReviewReason ?? null,
        };
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
      body: `${updated.nickname ?? `${updated.make?.name ?? ''} ${updated.model?.name ?? ''}`.trim()} maʼlumotlari yangilandi.`,
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
    const model = await this.prisma.vehicleModelRef.findUnique({
      where: { id: vehicle.modelId },
      include: { variants: { select: VARIANT_SELECT } },
    });
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
    const generation = resolveGeneration({
      year: vehicle.year,
      trimId: null,
      variants: model.variants,
      chosenVariantId: variantModelId,
    });
    const plan = await this.prepareImage(vehicle.year, model, null, generation);
    return { variantModelId, plan };
  }

  /** The image plan for the catalog row the vehicle is pictured as. */
  private prepareImage(
    year: number,
    model: VariantRow,
    trim: { id: string; modelId: string; name: string } | null,
    generation: ReturnType<typeof resolveGeneration>,
  ): Promise<IdentityPlan | null> {
    const subject = imageSubject(model, generation);
    return 'review' in subject
      ? this.images.prepare({
          year,
          model: null,
          trim: null,
          review: subject.review,
        })
      : this.images.prepare({ year, model: subject.model, trim });
  }

  private async assertCatalogRefs(dto: CreateVehicleDto) {
    const model = await this.prisma.vehicleModelRef.findUnique({
      where: { id: dto.model_id },
      include: { variants: { select: VARIANT_SELECT } },
    });
    if (!model || model.makeId !== dto.make_id) {
      throw new BadRequestException('Unknown or mismatched make_id/model_id');
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
