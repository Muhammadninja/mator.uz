import { Injectable, NotFoundException } from '@nestjs/common';
import { SellerStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SellersService {
  constructor(private readonly prisma: PrismaService) {}

  findByTgId(tgId: bigint) {
    return this.prisma.seller.findUnique({ where: { tgId } });
  }

  findAll(status?: SellerStatus) {
    return this.prisma.seller.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  findPending() {
    return this.findAll(SellerStatus.PENDING);
  }

  async upsertFromBot(tgId: bigint, storeName: string, phone = '') {
    return this.prisma.seller.upsert({
      where: { tgId },
      update: {},
      create: { tgId, storeName, phone, status: SellerStatus.PENDING },
    });
  }

  async updateStatus(id: number, status: SellerStatus) {
    const seller = await this.prisma.seller.findUnique({ where: { id } });
    if (!seller) throw new NotFoundException(`Seller #${id} not found`);
    return this.prisma.seller.update({ where: { id }, data: { status } });
  }
}
