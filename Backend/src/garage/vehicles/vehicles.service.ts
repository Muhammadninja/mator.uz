import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Drivetrain, FuelType, NotificationType, VehicleTransmission } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../../common/ulid.util';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VEHICLE_INCLUDE, presentVehicle } from './vehicle.presenter';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NotificationsService } from '../../notifications/notifications.service';

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
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
    await this.assertCatalogRefs(dto);
    const model3dAssetId = dto.trim_id ? await this.resolve3dAsset(dto.trim_id) : null;

    // First vehicle is always primary; otherwise honor the requested flag.
    const existingCount = await this.prisma.vehicle.count({ where: { userId, deletedAt: null } });
    const makePrimary = dto.is_primary === true || existingCount === 0;

    const created = await this.prisma.$transaction(async (tx) => {
      if (makePrimary) {
        await tx.vehicle.updateMany({
          where: { userId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      return tx.vehicle.create({
        data: {
          id: prefixedId(IdPrefix.VEHICLE),
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
        },
        include: VEHICLE_INCLUDE,
      });
    });

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
    await this.assertOwned(userId, vehicleId);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.is_primary === true) {
        await tx.vehicle.updateMany({
          where: { userId, isPrimary: true, id: { not: vehicleId } },
          data: { isPrimary: false },
        });
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
        },
        include: VEHICLE_INCLUDE,
      });
    });

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

  private async assertCatalogRefs(dto: CreateVehicleDto) {
    const model = await this.prisma.vehicleModelRef.findUnique({ where: { id: dto.model_id } });
    if (!model || model.makeId !== dto.make_id) {
      throw new BadRequestException('Unknown or mismatched make_id/model_id');
    }
    if (dto.trim_id) {
      const trim = await this.prisma.vehicleTrim.findUnique({ where: { id: dto.trim_id } });
      if (!trim || trim.modelId !== dto.model_id) {
        throw new BadRequestException('Unknown or mismatched trim_id');
      }
    }
    if (dto.engine_id) {
      const engine = await this.prisma.vehicleEngine.findUnique({ where: { id: dto.engine_id } });
      if (!engine) throw new BadRequestException('Unknown engine_id');
    }
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
