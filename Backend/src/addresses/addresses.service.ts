import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { presentAddress } from './address.presenter';

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
