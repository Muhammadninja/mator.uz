import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { presentAddress } from './address.presenter';

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
  lat?: number;
  lng?: number;
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
  constructor(private readonly prisma: PrismaService) {}

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
          lat: dto.lat,
          lng: dto.lng,
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
    const existingCount = await this.prisma.address.count({ where: { userId } });
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
          fullText: dto.full_text,
          label: dto.label,
          regionCode: dto.region_code,
          district: dto.district,
          street: dto.street,
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
    await this.assertOwned(userId, id);

    const data: Prisma.AddressUpdateInput = {};
    if (dto.full_text !== undefined) data.fullText = dto.full_text;
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.region_code !== undefined) data.regionCode = dto.region_code;
    if (dto.district !== undefined) data.district = dto.district;
    if (dto.street !== undefined) data.street = dto.street;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;
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
