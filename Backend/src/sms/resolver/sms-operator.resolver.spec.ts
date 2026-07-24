import { SmsOperatorResolver } from './sms-operator.resolver';
import { PrismaService } from '../../prisma/prisma.service';

// Mirrors the seed: each operator with its 2-digit MSISDN prefixes and price.
// Shaped exactly like `prisma.smsOperator.findMany({ include: { prefixes } })`.
const OPERATORS = [
  { id: 1, name: 'humans', priceUzs: 60, prefixes: [{ prefix: '33' }] },
  { id: 2, name: 'mobiuz', priceUzs: 100, prefixes: [{ prefix: '97' }, { prefix: '88' }, { prefix: '87' }] },
  { id: 3, name: 'perfectum', priceUzs: 110, prefixes: [{ prefix: '98' }, { prefix: '80' }] },
  { id: 4, name: 'uzmobile', priceUzs: 140, prefixes: [{ prefix: '95' }, { prefix: '99' }, { prefix: '77' }] },
  { id: 5, name: 'beeline', priceUzs: 155, prefixes: [{ prefix: '90' }, { prefix: '91' }, { prefix: '92' }, { prefix: '20' }] },
  { id: 6, name: 'ucell', priceUzs: 160, prefixes: [{ prefix: '93' }, { prefix: '94' }, { prefix: '55' }, { prefix: '50' }, { prefix: '71' }] },
];

const makePrisma = () => {
  const findMany = jest.fn().mockResolvedValue(OPERATORS);
  const prisma = { smsOperator: { findMany } } as unknown as PrismaService;
  return { prisma, findMany };
};

describe('SmsOperatorResolver', () => {
  let resolver: SmsOperatorResolver;
  let findMany: jest.Mock;

  beforeEach(() => {
    const built = makePrisma();
    findMany = built.findMany;
    resolver = new SmsOperatorResolver(built.prisma);
  });

  it('resolves a Beeline number (prefix 90) to its price snapshot', async () => {
    await expect(resolver.resolve('+998901234567')).resolves.toEqual({
      operatorId: 5,
      operatorName: 'beeline',
      priceUzs: 155,
    });
  });

  it('resolves every Beeline prefix (90/91/92/20)', async () => {
    for (const p of ['90', '91', '92', '20']) {
      const r = await resolver.resolve(`+998${p}1234567`);
      expect(r?.operatorName).toBe('beeline');
      expect(r?.priceUzs).toBe(155);
    }
  });

  it('resolves a Ucell number (prefix 93) to its price snapshot', async () => {
    await expect(resolver.resolve('+998931112233')).resolves.toEqual({
      operatorId: 6,
      operatorName: 'ucell',
      priceUzs: 160,
    });
  });

  it('resolves every Ucell prefix (93/94/55/50/71)', async () => {
    for (const p of ['93', '94', '55', '50', '71']) {
      const r = await resolver.resolve(`+998${p}9998877`);
      expect(r?.operatorName).toBe('ucell');
      expect(r?.priceUzs).toBe(160);
    }
  });

  it('resolves a Humans number (prefix 33) to its price snapshot', async () => {
    await expect(resolver.resolve('+998331234567')).resolves.toEqual({
      operatorId: 1,
      operatorName: 'humans',
      priceUzs: 60,
    });
  });

  it('accepts a bare 12-digit MSISDN without the leading + (digits are extracted)', async () => {
    await expect(resolver.resolve('998901234567')).resolves.toMatchObject({
      operatorName: 'beeline',
    });
  });

  it('returns null for a known-format number with an unknown prefix', async () => {
    // 44 is not assigned to any operator in the table.
    await expect(resolver.resolve('+998441234567')).resolves.toBeNull();
  });

  it('returns null for a malformed / non-Uzbek number without matching a prefix', async () => {
    await expect(resolver.resolve('+12025550123')).resolves.toBeNull(); // US number
    await expect(resolver.resolve('+99890123')).resolves.toBeNull(); // too short
    await expect(resolver.resolve('')).resolves.toBeNull(); // empty
  });

  describe('caching', () => {
    it('queries the database only once across many resolves', async () => {
      await resolver.resolve('+998901234567');
      await resolver.resolve('+998931112233');
      await resolver.resolve('+998331234567');
      await resolver.resolve('+998441234567');
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('shares a single load across concurrent first-callers', async () => {
      await Promise.all([
        resolver.resolve('+998901234567'),
        resolver.resolve('+998931112233'),
        resolver.resolve('+998881112233'),
      ]);
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('reloads after invalidate()', async () => {
      await resolver.resolve('+998901234567');
      expect(findMany).toHaveBeenCalledTimes(1);

      resolver.invalidate();
      await resolver.resolve('+998901234567');
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('does not poison the cache when the first load fails (retries next call)', async () => {
      findMany.mockRejectedValueOnce(new Error('db down'));

      await expect(resolver.resolve('+998901234567')).rejects.toThrow('db down');
      // A later call retries the query rather than reusing the failed promise.
      await expect(resolver.resolve('+998901234567')).resolves.toMatchObject({
        operatorName: 'beeline',
      });
      expect(findMany).toHaveBeenCalledTimes(2);
    });
  });
});
