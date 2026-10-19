/**
 * Proof that a dry run never writes — not by trusting the flag, but by
 * recording every database call the PRODUCTION store (PrismaDriversVillageStore)
 * makes. Prisma is replaced by a proxy that logs each model operation and raw
 * query, answers the reads with a small "database" (one existing position),
 * and refuses anything else. A real import over the same proxy is the control:
 * it must reach the write path, so the recorder demonstrably sees writes.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { DriversVillageImportService } from './drivers-village-import.service';
import { PrismaDriversVillageStore } from './drivers-village.store';

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

function recordingPrisma(storedCodes = ['96273708', 'OLD-1']) {
  const calls: string[] = [];
  const sql: string[] = [];
  type Args = { select?: Record<string, unknown> };
  const reads: Record<string, (args: Args) => unknown> = {
    'catalogSeller.findUnique': () => ({
      id: 'drivers-village',
      name: 'Drivers Village',
    }),
    'seller.findUnique': () => ({
      id: 7,
      status: 'ACTIVE',
      sellerType: 'BUSINESS',
    }),
    'vehicleMake.findMany': () => [{ id: 1, name: 'Chevrolet' }],
    'vehicleModelRef.findMany': () => [{ makeId: 1, name: 'Cobalt' }],
    'stock.findMany': (args) =>
      args.select?.product
        ? [
            {
              id: 11,
              sourceCode: '96273708',
              priceUzs: new Prisma.Decimal('100000'),
              quantity: 3,
              unit: 'PCS',
              productId: 21,
              product: {
                title: 'Фильтр масляный',
                gmNumbers: [],
                sourcePartNumber: '96273708',
                oemNumbers: ['96273708'],
                categoryId: null,
                isUniversal: false,
                partModels: [
                  { model: { name: 'Cobalt', brand: { name: 'Chevrolet' } } },
                ],
                partMakes: [],
                _count: { images: 2 },
              },
            },
          ]
        : storedCodes.map((sourceCode) => ({ sourceCode })),
    'catalogPart.findMany': () => [
      { id: 'part_stock_11', categoryId: 'oil-filters' },
    ],
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_t, op: string) =>
          (args: Args = {}) => {
            calls.push(`${name}.${op}`);
            const answer = reads[`${name}.${op}`];
            if (!READ_OPERATIONS.has(op) || !answer)
              return Promise.reject(
                new Error(`write or unexpected call: ${name}.${op}`),
              );
            return Promise.resolve(answer(args));
          },
      },
    );
  const prisma = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === '$queryRaw')
          return (strings: TemplateStringsArray) => {
            calls.push('$queryRaw');
            sql.push(strings.join('?'));
            return Promise.resolve([{ n: 7n }]);
          };
        if (prop.startsWith('$'))
          return () => {
            calls.push(prop); // $transaction, $executeRaw…, $queryRawUnsafe…
            return Promise.reject(new Error(`write path ${prop}`));
          };
        return model(prop);
      },
    },
  ) as unknown as PrismaClient;
  return { prisma, calls, sql };
}

const FILE = Buffer.from(
  [
    'code_1c;name;quantity;unit;price;vehicle_make;vehicle_model',
    '96273708;Фильтр масляный;12;шт.;123,456;CHEVROLET;COBALT', // update (price, quantity)
    '95015324;Колодки тормозные;2,268;шт.;1,100,000;CHEVROLET;COBALT', // create
    '96350526;Амортизатор;5;шт.;450,000;CHEVROLET;COBALT', // repeated code
    '96350526;Амортизатор;7;шт.;520,000;CHEVROLET;COBALT',
    '3333;Коврик;1;шт.;50,000;;', // rejected
  ].join('\r\n'),
  'utf-8',
);

function setup(storedCodes?: string[]) {
  const db = recordingPrisma(storedCodes);
  const projected: number[] = [];
  const service = new DriversVillageImportService(
    new PrismaDriversVillageStore(db.prisma),
    {
      projectStock: (id: number) => {
        projected.push(id);
        return Promise.reject(new Error('projection is a write'));
      },
    },
  );
  return { ...db, projected, service };
}

describe('Driver’s Village — a dry run issues reads only (production store, recorded)', () => {
  it('plans creates, updates and repeats while every database call is a read', async () => {
    const { service, calls, sql, projected } = setup();
    const report = await service.run(FILE, 'dv.txt', { dryRun: true });

    expect(report.meta).toMatchObject({ mode: 'dry-run', aborted: false });
    expect(report.summary).toMatchObject({
      rowsToCreate: 2,
      rowsToUpdate: 1,
      rowsMerged: 1,
      rejectedRows: 1,
      written: null,
    });
    expect(report.positionsNotInFile).toEqual(['OLD-1']);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const [, op] = call.split('.');
      expect(call === '$queryRaw' || READ_OPERATIONS.has(op)).toBe(true);
    }
    expect(calls).not.toContain('$transaction');
    expect(sql).toHaveLength(1); // the schema check
    for (const query of sql) expect(query.trim()).toMatch(/^SELECT\b/i);
    expect(sql.join(' ')).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|ALTER|CREATE|DROP|TRUNCATE)\b/i,
    );
    expect(projected).toEqual([]);
  });

  it('a match by the 8-digit key and a key conflict are planned with reads only', async () => {
    const { service, calls, projected } = setup([
      '96273708',
      '96350526',
      '96350526-B',
    ]);
    const report = await service.run(
      Buffer.from(
        [
          'code_1c;name;quantity;unit;price;vehicle_make;vehicle_model',
          '96273708 GMB;Фильтр масляный;12;шт.;123,456;CHEVROLET;COBALT', // → stored 96273708
          '96350526 OEM;Амортизатор;5;шт.;450,000;CHEVROLET;COBALT', // provable, but two stored with the key
        ].join('\r\n'),
        'utf-8',
      ),
      'dv.txt',
      { dryRun: true },
    );

    expect(report.summary).toMatchObject({
      rowsToUpdate: 1,
      rowsMatchedByKey: 1,
      keyConflicts: 1,
      rowsInKeyConflict: 1,
      written: null,
    });
    expect(report.keyMatches[0]).toMatchObject({
      storedCode: '96273708',
      stockId: 11,
    });
    for (const call of calls) {
      const [, op] = call.split('.');
      expect(call === '$queryRaw' || READ_OPERATIONS.has(op)).toBe(true);
    }
    expect(calls).not.toContain('$transaction');
    expect(projected).toEqual([]);
  });

  it('control: a real import over the same recorder reaches the write path', async () => {
    const { service, calls } = setup();
    const report = await service.run(FILE, 'dv.txt', { dryRun: false });
    expect(calls).toContain('$transaction');
    expect(report.meta.aborted).toBe(true); // the recorder refused the write
  });
});
