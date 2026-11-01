import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListAdminOrdersQueryDto } from './list-admin-orders.query.dto';

const errorsFor = async (query: Record<string, unknown>) =>
  validate(plainToInstance(ListAdminOrdersQueryDto, query));

describe('ListAdminOrdersQueryDto', () => {
  it('takes a customer id', async () => {
    expect(
      await errorsFor({ customerId: '00000000-0000-4000-8000-000000000001' }),
    ).toHaveLength(0);
  });

  // The column is a UUID: anything else would reach PostgreSQL and come back a 500.
  it.each(['not-a-uuid', '1', "' OR 1=1"])('refuses %s', async (customerId) => {
    expect(await errorsFor({ customerId })).toHaveLength(1);
  });

  it('is optional', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });
});
