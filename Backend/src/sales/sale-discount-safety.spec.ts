/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the Prisma harness (test/utils/harness.ts) is untyped by design */
// SEC-002 (validation only): a FIXED discount has to leave something to pay, and
// every role that could manage sales before still can.
import {
  AdminRole,
  Prisma,
  SaleDiscountType,
  SaleScopeType,
} from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ADMIN_ROLES_KEY } from '../admin/auth/decorators/roles.decorator';
import { CreateSaleDto } from './dto/create-sale.dto';
import { AdminSalesController } from './admin-sales.controller';
import { DiscountService } from './discount.service';
import { SalesService } from './sales.service';
import { createPrismaMock } from '../../test/utils/harness';

const START = '2026-12-01T00:00:00.000Z';
const fixed = (discountValue: number, extra: object = {}) =>
  ({
    title: 'Sale',
    discountType: SaleDiscountType.FIXED,
    discountValue,
    startAt: START,
    ...extra,
  }) as never;

function build() {
  const prisma: any = createPrismaMock();
  const service = new SalesService(prisma, new DiscountService(prisma));
  prisma.sale.findUniqueOrThrow.mockResolvedValue({
    id: 'sale_1',
    title: 'Sale',
    description: null,
    discountType: SaleDiscountType.FIXED,
    discountValue: new Prisma.Decimal(1000),
    scopeType: SaleScopeType.ALL_PRODUCTS,
    startAt: new Date(START),
    endAt: null,
    isActive: true,
    priority: 0,
    deletedAt: null,
    createdAt: new Date(START),
    updatedAt: new Date(START),
    targets: [],
    _count: { targets: 0 },
  });
  return { prisma, service };
}

const existing = {
  id: 'sale_1',
  discountType: SaleDiscountType.FIXED,
  discountValue: new Prisma.Decimal(1000),
  scopeType: SaleScopeType.ALL_PRODUCTS,
  startAt: new Date(START),
  endAt: null,
};

describe('saving a FIXED sale', () => {
  it('rejects a store-wide amount at or above the cheapest product', async () => {
    const { prisma, service } = build();
    prisma.catalogPart.findFirst.mockResolvedValue({ priceUzs: 5_000 });

    await expect(service.create(fixed(5_000))).rejects.toThrow(
      /below the cheapest product/,
    );
    await expect(service.create(fixed(1_000_000_000))).rejects.toThrow(
      /below the cheapest product/,
    );
    expect(prisma.sale.create).not.toHaveBeenCalled();
  });

  it('rejects an amount that rounds up to the price', async () => {
    const { prisma, service } = build();
    prisma.catalogPart.findFirst.mockResolvedValue({ priceUzs: 5_000 });

    await expect(service.create(fixed(4_999.6))).rejects.toThrow(
      /below the cheapest product/,
    );
  });

  it('accepts an amount below the cheapest product', async () => {
    const { prisma, service } = build();
    prisma.catalogPart.findFirst.mockResolvedValue({ priceUzs: 5_000 });

    await service.create(fixed(4_999));

    expect(prisma.sale.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [SaleScopeType.PRODUCTS, 'catalogPart', { id: { in: ['t1'] } }],
    [SaleScopeType.CATEGORIES, 'partCategory', { categoryId: { in: ['t1'] } }],
    [SaleScopeType.DEALERS, 'catalogSeller', { sellerId: { in: ['t1'] } }],
  ])(
    'measures %s against only the parts it covers',
    async (scopeType, table, where) => {
      const { prisma, service } = build();
      prisma[table].count.mockResolvedValue(1);
      prisma.catalogPart.findFirst.mockResolvedValue(null);

      await service.create(fixed(1_000, { scopeType, targetIds: ['t1'] }));

      expect(prisma.catalogPart.findFirst.mock.calls[0][0].where).toMatchObject(
        where,
      );
      expect(
        prisma.catalogPart.findFirst.mock.calls[0][0].where.priceUzs,
      ).toEqual({ gt: 0 });
    },
  );

  it('does not look at prices for a PERCENT sale', async () => {
    const { prisma, service } = build();

    await service.create({
      title: 'Sale',
      discountType: SaleDiscountType.PERCENT,
      discountValue: 20,
      startAt: START,
    } as never);

    expect(prisma.catalogPart.findFirst).not.toHaveBeenCalled();
  });

  describe('on update', () => {
    it('rejects raising the amount past the cheapest product', async () => {
      const { prisma, service } = build();
      prisma.sale.findFirst.mockResolvedValue(existing);
      prisma.catalogPart.findFirst.mockResolvedValue({ priceUzs: 5_000 });

      await expect(
        service.update('sale_1', { discountValue: 5_000 } as never),
      ).rejects.toThrow(/below the cheapest product/);
      expect(prisma.sale.update).not.toHaveBeenCalled();
    });

    it('rejects switching a PERCENT value into a FIXED amount that is too large', async () => {
      const { prisma, service } = build();
      prisma.sale.findFirst.mockResolvedValue({
        ...existing,
        discountType: SaleDiscountType.PERCENT,
        discountValue: new Prisma.Decimal(20),
      });
      prisma.catalogPart.findFirst.mockResolvedValue({ priceUzs: 10 });

      await expect(
        service.update('sale_1', {
          discountType: SaleDiscountType.FIXED,
        } as never),
      ).rejects.toThrow(/below the cheapest product/);
    });

    it('checks the stored targets when only the amount changes', async () => {
      const { prisma, service } = build();
      prisma.sale.findFirst.mockResolvedValue({
        ...existing,
        scopeType: SaleScopeType.PRODUCTS,
      });
      prisma.saleTarget.findMany.mockResolvedValue([{ targetId: 'p1' }]);
      prisma.catalogPart.findFirst.mockResolvedValue(null);

      await service.update('sale_1', { discountValue: 2_000 } as never);

      expect(prisma.catalogPart.findFirst.mock.calls[0][0].where.id).toEqual({
        in: ['p1'],
      });
    });

    it('a rename is not refused because a price has fallen since', async () => {
      const { prisma, service } = build();
      prisma.sale.findFirst.mockResolvedValue(existing);
      prisma.catalogPart.findFirst.mockResolvedValue({ priceUzs: 10 });

      await service.update('sale_1', { title: 'New name' } as never);

      expect(prisma.catalogPart.findFirst).not.toHaveBeenCalled();
      expect(prisma.sale.update).toHaveBeenCalledTimes(1);
    });
  });
});

describe('a PERCENT sale of 99.99%', () => {
  const percent = {
    title: 'Sale',
    discountType: SaleDiscountType.PERCENT,
    discountValue: 99.99,
    startAt: START,
  };

  it('passes the DTO', () => {
    expect(validateSync(plainToInstance(CreateSaleDto, percent))).toEqual([]);
  });

  it('is saved on create and on update', async () => {
    const { prisma, service } = build();
    prisma.sale.findFirst.mockResolvedValue({
      ...existing,
      discountType: SaleDiscountType.PERCENT,
      discountValue: new Prisma.Decimal(10),
    });

    await service.create(percent as never);
    await service.update('sale_1', { discountValue: 99.99 } as never);

    expect(prisma.sale.create).toHaveBeenCalledTimes(1);
    expect(prisma.sale.update).toHaveBeenCalledTimes(1);
  });

  it('prices a product down to what is left', () => {
    const { prisma } = build();
    const result = new DiscountService(prisma).calculateDiscount(
      100_000,
      { id: 'p1' },
      [
        {
          id: 's1',
          title: 'Sale',
          discountType: SaleDiscountType.PERCENT,
          discountValue: new Prisma.Decimal(99.99),
          scopeType: SaleScopeType.ALL_PRODUCTS,
          priority: 0,
          createdAt: new Date(START),
          targets: [],
        } as never,
      ],
    );

    expect(result.finalPrice).toBe(10);
    expect(result.appliedSale?.discountValue).toBe(99.99);
  });
});

describe('existing role rules', () => {
  it('still admits SUPER_ADMIN, MANAGER and OPERATOR on the whole controller', () => {
    expect(Reflect.getMetadata(ADMIN_ROLES_KEY, AdminSalesController)).toEqual([
      AdminRole.SUPER_ADMIN,
      AdminRole.MANAGER,
      AdminRole.OPERATOR,
    ]);
  });

  it.each(['create', 'update', 'remove'] as const)(
    '%s adds no role rule of its own, so OPERATOR keeps it',
    (method) => {
      expect(
        Reflect.getMetadata(
          ADMIN_ROLES_KEY,
          AdminSalesController.prototype[method],
        ),
      ).toBeUndefined();
    },
  );

  it('an operator request still creates, updates and deletes', async () => {
    const { prisma, service } = build();
    const controller = new AdminSalesController(service);
    prisma.catalogPart.findFirst.mockResolvedValue({ priceUzs: 50_000 });
    prisma.sale.findFirst.mockResolvedValue(existing);
    prisma.sale.findUnique.mockResolvedValue({ id: 'sale_1', deletedAt: null });

    await controller.create(fixed(1_000));
    await controller.update('sale_1', { discountValue: 2_000 } as never);
    await expect(controller.remove('sale_1')).resolves.toMatchObject({
      data: { id: 'sale_1', deleted: true },
    });

    expect(prisma.sale.create).toHaveBeenCalledTimes(1);
    expect(prisma.sale.update).toHaveBeenCalledTimes(2);
  });
});
