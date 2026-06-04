import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface GetProductsQuery {
  page?: number;
  limit?: number;
  carModel?: string;
}

export interface ProductWithStock {
  id: number;
  gmNumber: string | null;
  title: string;
  carModel: string | null;
  imageUrl: string | null;
  createdAt: Date;
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

    // Build where clause for filtering
    const where: any = {};
    if (query.carModel) {
      where.carModel = {
        contains: query.carModel,
        mode: 'insensitive',
      };
    }

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        include: {
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
        orderBy: {
          createdAt: 'desc',
        },
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
}
