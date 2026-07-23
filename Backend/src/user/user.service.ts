import { Injectable, NotFoundException } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddressesService } from '../addresses/addresses.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { presentMe } from './user.presenter';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly addresses: AddressesService,
  ) {}

  async getMe(userId: string) {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('User not found');
    const address = await this.addresses.getDefault(userId);
    return presentMe(user, address);
  }

  /**
   * Partial update — only fields present in the DTO are written. An inline
   * `address` upserts the caller's DEFAULT address through AddressesService
   * (single source of truth; never duplicates), and the resulting default
   * address is always echoed back so the client stays in sync.
   */
  async updateMe(userId: string, dto: UpdateMeDto) {
    const data: Prisma.AppUserUpdateInput = {};
    if (dto.display_name !== undefined) data.displayName = dto.display_name;
    if (dto.first_name !== undefined) data.firstName = dto.first_name;
    if (dto.last_name !== undefined) data.lastName = dto.last_name;
    if (dto.avatar_url !== undefined) data.avatarUrl = dto.avatar_url;
    if (dto.language !== undefined)
      data.language = dto.language.toUpperCase() as Language;

    try {
      const user = await this.prisma.appUser.update({
        where: { id: userId },
        data,
      });

      // Upsert the default address only when the client sent one; otherwise the
      // existing default (if any) is left untouched.
      const address = dto.address
        ? await this.addresses.upsertDefault(userId, dto.address)
        : await this.addresses.getDefault(userId);

      return presentMe(user, address);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }
      throw err;
    }
  }
}
