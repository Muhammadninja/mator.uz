// src/database/prisma.service.ts
import { PrismaClient } from '@prisma/client';

const isDev = process.env.NODE_ENV !== 'production';

class PrismaService extends PrismaClient {
  private static instance: PrismaService;

  private constructor() {
    super({
      log: isDev ? ['query', 'warn', 'error'] : ['error'],
    });
  }

  static getInstance(): PrismaService {
    if (!PrismaService.instance) {
      PrismaService.instance = new PrismaService();
    }
    return PrismaService.instance;
  }

  async disconnect(): Promise<void> {
    await this.$disconnect();
  }
}

export const prisma = PrismaService.getInstance();
