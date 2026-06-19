import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface GetProductsQuery {
  page?: number;
  limit?: number;
  brand?: string;
  model?: string;
  title?: string;
  gmNumber?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
}

export interface ProductWithStock {
  id: number;
  gmNumber: string | null;
  title: string;
  description: string | null;
  imageUrl: string | null;
  createdAt: Date;
  partModels: Array<{
    model: {
      id: number;
      name: string;
      brand: {
        id: number;
        name: string;
      };
    };
  }>;
  stocks: Array<{
    id: number;
    priceUzs: string;
    quantity: number;
    seller: {
      id: number;
      storeName: string | null;
      marketName: string | null;
    };
  }>;
}

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async getProducts(query: GetProductsQuery) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query.title) {
      where.title = { contains: query.title, mode: 'insensitive' };
    }

    if (query.gmNumber) {
      where.gmNumber = { contains: query.gmNumber, mode: 'insensitive' };
    }

    if (query.brand || query.model) {
      where.partModels = {
        some: {
          model: {
            ...(query.model
              ? { name: { contains: query.model, mode: 'insensitive' } }
              : {}),
            ...(query.brand
              ? { brand: { name: { contains: query.brand, mode: 'insensitive' } } }
              : {}),
          },
        },
      };
    }

    // Price filter (price lives on Stock) — match products with a stock in range.
    if (query.minPrice != null || query.maxPrice != null) {
      const priceUzs: { gte?: number; lte?: number } = {};
      if (query.minPrice != null) priceUzs.gte = query.minPrice;
      if (query.maxPrice != null) priceUzs.lte = query.maxPrice;
      where.stocks = { some: { priceUzs } };
    }

    // Unified free-text search across title, description, OEM number, brand, and models.
    if (query.search) {
      const term = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { title: term },
        { description: term },
        { gmNumber: term },
        { partModels: { some: { model: { name: term } } } },
        { partModels: { some: { model: { brand: { name: term } } } } },
      ];
    }

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: {
          partModels: {
            include: {
              model: {
                include: { brand: true },
              },
            },
          },
          stocks: {
            include: {
              seller: {
                select: {
                  id: true,
                  storeName: true,
                  marketName: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getProductById(id: number) {
    return this.prisma.product.findUnique({
      where: { id },
      include: {
        partModels: {
          include: {
            model: {
              include: { brand: true },
            },
          },
        },
        stocks: {
          include: {
            seller: {
              select: {
                id: true,
                storeName: true,
                marketName: true,
                phone: true,
                locationLat: true,
                locationLng: true,
              },
            },
          },
        },
      },
    });
  }

  async getBrands() {
    return this.prisma.brand.findMany({
      orderBy: { name: 'asc' },
      include: {
        models: {
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        },
      },
    });
  }

  async getModelsByBrand(brandId: number) {
    return this.prisma.carModel.findMany({
      where: { brandId },
      orderBy: { name: 'asc' },
    });
  }
}
