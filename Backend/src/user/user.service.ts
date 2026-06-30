import { Injectable, NotFoundException } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { presentMe } from './user.presenter';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.appUser.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return presentMe(user);
  }

  /** Partial update — only fields present in the DTO are written. */
  async updateMe(userId: string, dto: UpdateMeDto) {
    const data: Prisma.AppUserUpdateInput = {};
    if (dto.display_name !== undefined) data.displayName = dto.display_name;
    if (dto.first_name !== undefined) data.firstName = dto.first_name;
    if (dto.last_name !== undefined) data.lastName = dto.last_name;
    if (dto.avatar_url !== undefined) data.avatarUrl = dto.avatar_url;
    if (dto.language !== undefined) data.language = dto.language.toUpperCase() as Language;

    try {
      const user = await this.prisma.appUser.update({ where: { id: userId }, data });
      return presentMe(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw err;
    }
  }
}
