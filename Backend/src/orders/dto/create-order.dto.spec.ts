// LOW-ORD-010: CreateOrderDto refuses bad input with 400 instead of a Prisma 500,
// and accepts exactly what the mobile app sends.

import { ValidationPipe } from '@nestjs/common';
import { CreateOrderDto } from './create-order.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const run = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: CreateOrderDto });

describe('CreateOrderDto', () => {
  it('accepts the payload the mobile app sends today', async () => {
    const dto = await run({
      cart_snapshot: {
        delivery_method: 'courier',
        delivery_address_id: null,
        promo_code: null,
      },
      vehicle_id: 'veh_01HX',
      contact_phone_e164: '+998901234567',
      payment_type: 'payme',
      confirmed_delivery_uzs: 25_000,
      delivery_quote_id: 'dq_abc',
      confirmed_total_uzs: 215_000,
    });
    expect(dto.cart_snapshot).toMatchObject({ delivery_method: 'courier' });
  });

  it('accepts pickup with an address id, and the method in any case', async () => {
    const dto = await run({
      cart_snapshot: {
        delivery_method: 'PICKUP',
        delivery_address_id: 'addr_1',
      },
    });
    expect(dto.cart_snapshot!.delivery_method).toBe('pickup');
  });

  it('accepts an order with no snapshot at all (older clients)', async () => {
    await expect(run({})).resolves.toBeDefined();
  });

  it.each([
    ['a numeric address id', { cart_snapshot: { delivery_address_id: 42 } }],
    [
      'an object address id',
      { cart_snapshot: { delivery_address_id: { id: 'a' } } },
    ],
    ['an empty address id', { cart_snapshot: { delivery_address_id: '' } }],
    [
      'an oversized address id',
      { cart_snapshot: { delivery_address_id: 'a'.repeat(65) } },
    ],
    ['an empty vehicle id', { vehicle_id: '' }],
    ['a non-object snapshot', { cart_snapshot: 'courier' }],
    [
      'an unknown nested property',
      { cart_snapshot: { delivery_method: 'courier', discount: 99 } },
    ],
    [
      'an unknown delivery method',
      { cart_snapshot: { delivery_method: 'drone' } },
    ],
    ['an unknown payment type', { payment_type: 'crypto' }],
    ['a malformed phone', { contact_phone_e164: '901234567' }],
    ['a phone with letters', { contact_phone_e164: '+99890abc4567' }],
    ['an oversized phone', { contact_phone_e164: `+${'9'.repeat(25)}` }],
    ['a negative total', { confirmed_total_uzs: -1 }],
    ['a non-finite total', { confirmed_total_uzs: Infinity }],
    ['an unknown top-level property', { total_to_charge: 1 }],
  ])('refuses %s with 400', async (_name, body) => {
    await expect(run(body)).rejects.toMatchObject({ status: 400 });
  });
});
