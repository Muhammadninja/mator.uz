// Real PostgreSQL owner isolation checks using two disposable customers.
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AddressesService } from '../../src/addresses/addresses.service';
import { CartService } from '../../src/cart/cart.service';
import { OrdersService } from '../../src/orders/orders.service';
import { fakeConfig } from '../utils/harness';
import { describeWithDb, integrationPrisma } from '../utils/integration-db';

describeWithDb('customer object authorization (real PostgreSQL)', () => {
  let prisma: PrismaClient;
  const owners = [randomUUID(), randomUUID()];
  const addressId = `addr_sec_${randomUUID()}`;
  const orderId = `ord_sec_${randomUUID()}`;
  const cartId = `cart_sec_${randomUUID()}`;
  const cartItemId = `ci_sec_${randomUUID()}`;

  beforeAll(async () => {
    prisma = integrationPrisma();
    await prisma.appUser.createMany({ data: owners.map((id) => ({ id })) });
    await prisma.address.create({
      data: { id: addressId, userId: owners[0], fullText: 'Synthetic test address' },
    });
    await prisma.order.create({
      data: { id: orderId, userId: owners[0], subtotalUzs: 1000, totalUzs: 1000 },
    });
    await prisma.cart.create({ data: { id: cartId, userId: owners[0] } });
    await prisma.cartItem.create({
      data: { id: cartItemId, cartId, title: 'Synthetic line', priceUzsSnapshot: 1000 },
    });
  });

  afterAll(async () => {
    await prisma.cartItem.deleteMany({ where: { id: cartItemId } });
    await prisma.cart.deleteMany({ where: { id: cartId } });
    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
    await prisma.appUser.deleteMany({ where: { id: { in: owners } } });
    await prisma.$disconnect();
  });

  it('does not return another customer\'s order', async () => {
    const service = Object.assign(Object.create(OrdersService.prototype), { prisma });
    await expect(service.getOrder(owners[1], orderId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(prisma.order.findUnique({ where: { id: orderId } })).resolves.toMatchObject({ userId: owners[0] });
  });

  it('does not update or delete another customer\'s address', async () => {
    const service = new AddressesService(prisma as never, fakeConfig());
    await expect(service.update(owners[1], addressId, { label: 'Attacker' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(owners[1], addressId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(prisma.address.findUnique({ where: { id: addressId } })).resolves.toMatchObject({
      userId: owners[0], label: null,
    });
  });

  it('does not change another customer\'s cart line quantity', async () => {
    const service = new CartService(prisma as never, {} as never);
    await expect(service.updateItem(owners[1], cartItemId, 99)).rejects.toBeInstanceOf(NotFoundException);
    await expect(prisma.cartItem.findUnique({ where: { id: cartItemId } })).resolves.toMatchObject({ quantity: 1 });
  });
});
