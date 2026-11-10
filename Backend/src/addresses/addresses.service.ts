import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import {
  DELIVERY_ADDRESS_COORDINATES_INVALID,
  DELIVERY_OUTSIDE_COVERAGE,
  DeliveryCoverage,
  isWithinCoverage,
} from '../shipping/delivery-coverage';
import { readDeliveryCoverage } from '../shipping/delivery.config';
import { GeoPoint, toGeoPoint } from '../shipping/routing/routing-provider';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { presentAddress } from './address.presenter';

/** More than any buyer delivers to; the limit is on points to price routes from. */
const MAX_ADDRESSES_PER_USER = 20;

/**
 * Structural shape accepted by {@link AddressesService.upsertDefault}. Matches
 * the snake_case address contract (and CreateAddressDto minus `is_default`),
 * declared here so callers in other modules (e.g. the profile PATCH /v1/me) can
 * reuse this method without a cross-module DTO import / circular dependency.
 */
export interface AddressInput {
  full_text: string;
  label?: string;
  region_code?: string;
  district?: string;
  street?: string;
  landmark?: string | null;
  lat?: number;
  lng?: number;
}

/** A hint with nothing in it is no hint. */
function cleanLandmark(landmark: string | null | undefined): string | null | undefined {
  return landmark === undefined ? undefined : landmark?.trim() || null;
}

/**
 * Whether an edit moves an address on paper while leaving its old point on the map. Courier
 * delivery is priced from that point, so keeping it would charge for a trip to where the
 * buyer used to be. Clearing it makes the buyer state the new location before a courier
 * can be priced. An edit that states a point, or changes only the label, keeps what it has.
 */
function leavesStalePoint(
  existing: {
    fullText: string;
    street: string | null;
    district: string | null;
    lat: number | null;
    lng: number | null;
  },
  edit: {
    full_text?: string;
    street?: string;
    district?: string;
    lat?: number;
    lng?: number;
  },
): boolean {
  if (existing.lat === null && existing.lng === null) return false;
  if (edit.lat !== undefined || edit.lng !== undefined) return false;
  return (
    (edit.full_text !== undefined && edit.full_text !== existing.fullText) ||
    (edit.street !== undefined && edit.street !== existing.street) ||
    (edit.district !== undefined && edit.district !== existing.district)
  );
}

/** An address needs words or a point. With neither there is nothing to deliver to. */
export const ADDRESS_TEXT_OR_POINT_REQUIRED = 'ADDRESS_TEXT_OR_POINT_REQUIRED';

/**
 * The text an address is stored under. A point with no words is a valid destination, and the
 * operator and the courier still need something to read, so it becomes its own description.
 */
function addressText(
  fullText: string | undefined,
  point: GeoPoint | null,
): string {
  if (fullText?.trim()) return fullText;
  if (point) return `${point.lat}, ${point.lng}`;
  throw new BadRequestException({
    code: ADDRESS_TEXT_OR_POINT_REQUIRED,
    message: 'An address needs either its text or a location.',
  });
}

/**
 * User address CRUD. Every operation is scoped to the authenticated user — a
 * user can only read/update/delete their own addresses. Default-address changes
 * are atomic (a single transaction demotes the others and promotes the target),
 * so there is never more than one default per user.
 *
 * Order.deliveryAddressId keeps referencing these rows unchanged; delete uses
 * the schema's existing onDelete: SetNull, so historical orders are unaffected.
 */
@Injectable()
export class AddressesService {
  /** Null when no delivery area is configured. See {@link statedPoint}. */
  private readonly coverage: DeliveryCoverage | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.coverage = readDeliveryCoverage((key) => config.get<string>(key));
  }

  /**
   * The point a request states, once it is known to be somewhere a courier can go, or null
   * when it states none. The buyer may choose any such point: home, work, someone else's
   * door. It is never compared with where they are or how near a seller it is.
   *
   * With no delivery area configured there is nothing to check it against. It is saved, so
   * the buyer keeps their address, and no courier can be quoted until an area exists.
   */
  private statedPoint(
    lat: number | null | undefined,
    lng: number | null | undefined,
  ): GeoPoint | null {
    if (lat == null && lng == null) return null;
    const point = toGeoPoint(lat, lng);
    if (!point) {
      throw new BadRequestException({
        code: DELIVERY_ADDRESS_COORDINATES_INVALID,
        message: 'A location needs a valid latitude and longitude together.',
      });
    }
    if (this.coverage && !isWithinCoverage(point, this.coverage)) {
      throw new UnprocessableEntityException({
        code: DELIVERY_OUTSIDE_COVERAGE,
        message: 'This location is outside the delivery area.',
      });
    }
    return point;
  }

  /** List the user's addresses (default first, then newest). */
  async list(userId: string) {
    const addresses = await this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return { items: addresses.map(presentAddress) };
  }

  /** The user's default address, or null when they have none. */
  async getDefault(userId: string) {
    const address = await this.prisma.address.findFirst({
      where: { userId, isDefault: true },
      orderBy: { createdAt: 'desc' },
    });
    return address ? presentAddress(address) : null;
  }

  /**
   * Upsert the caller's single DEFAULT address (used by PATCH /v1/me). If a
   * default already exists it is updated in place; otherwise a new default is
   * created. This guarantees at most one default and never spawns duplicates for
   * the profile's "one address" surface, while still storing into the same
   * Address table the checkout/address endpoints use (single source of truth).
   */
  async upsertDefault(userId: string, dto: AddressInput) {
    this.statedPoint(dto.lat, dto.lng);
    const existing = await this.prisma.address.findFirst({
      where: { userId, isDefault: true },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      const updated = await this.prisma.address.update({
        where: { id: existing.id },
        data: {
          fullText: dto.full_text,
          label: dto.label,
          regionCode: dto.region_code,
          district: dto.district,
          street: dto.street,
          landmark: cleanLandmark(dto.landmark),
          lat: dto.lat,
          lng: dto.lng,
          ...(leavesStalePoint(existing, dto) ? { lat: null, lng: null } : {}),
        },
      });
      return presentAddress(updated);
    }

    // No default yet: create one (demoting any stray defaults defensively so the
    // single-default invariant always holds).
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.address.create({
        data: {
          id: prefixedId(IdPrefix.ADDRESS),
          userId,
          fullText: dto.full_text,
          label: dto.label,
          regionCode: dto.region_code,
          district: dto.district,
          street: dto.street,
          landmark: cleanLandmark(dto.landmark),
          lat: dto.lat,
          lng: dto.lng,
          isDefault: true,
        },
      });
    });
    return presentAddress(created);
  }

  /** Create an address. First address for a user always becomes the default. */
  async create(userId: string, dto: CreateAddressDto) {
    const fullText = addressText(
      dto.full_text,
      this.statedPoint(dto.lat, dto.lng),
    );
    const existingCount = await this.prisma.address.count({ where: { userId } });
    if (existingCount >= MAX_ADDRESSES_PER_USER) {
      throw new ConflictException({
        code: 'ADDRESS_LIMIT_REACHED',
        message: 'You have saved the maximum number of addresses. Remove one to add another.',
      });
    }
    const makeDefault = dto.is_default === true || existingCount === 0;

    const created = await this.prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.address.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.create({
        data: {
          id: prefixedId(IdPrefix.ADDRESS),
          userId,
          fullText,
          label: dto.label,
          regionCode: dto.region_code,
          district: dto.district,
          street: dto.street,
          landmark: cleanLandmark(dto.landmark),
          lat: dto.lat,
          lng: dto.lng,
          isDefault: makeDefault,
        },
      });
    });
    return presentAddress(created);
  }

  /** Partial update. Setting is_default: true atomically promotes this address. */
  async update(userId: string, id: string, dto: UpdateAddressDto) {
    this.statedPoint(dto.lat, dto.lng);
    const existing = await this.assertOwned(userId, id);

    const data: Prisma.AddressUpdateInput = {};
    if (dto.full_text !== undefined) data.fullText = dto.full_text;
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.region_code !== undefined) data.regionCode = dto.region_code;
    if (dto.district !== undefined) data.district = dto.district;
    if (dto.street !== undefined) data.street = dto.street;
    if (dto.landmark !== undefined) data.landmark = cleanLandmark(dto.landmark);
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;
    if (leavesStalePoint(existing, dto)) {
      data.lat = null;
      data.lng = null;
    }
    if (dto.is_default !== undefined) data.isDefault = dto.is_default;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.is_default === true) {
        await tx.address.updateMany({
          where: { userId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.address.update({ where: { id }, data });
    });
    return presentAddress(updated);
  }

  /**
   * Delete an owned address. If it was the default and others remain, the newest
   * remaining address is promoted so the user still has a default. Orders that
   * referenced it keep their snapshot; the FK is SET NULL by the schema.
   */
  async remove(userId: string, id: string) {
    const existing = await this.assertOwned(userId, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id } });
      if (existing.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
        });
        if (next) {
          await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
        }
      }
    });
    return { id, deleted: true };
  }

  private async assertOwned(userId: string, id: string) {
    const a = await this.prisma.address.findUnique({ where: { id } });
    if (!a || a.userId !== userId) throw new NotFoundException('Address not found');
    return a;
  }
}
