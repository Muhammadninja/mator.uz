// Validation of the inventory batch update, through the same plainToInstance +
// validateSync pair the global ValidationPipe applies. The console sends null
// for an emptied cell, and a value that passes here reaches Prisma, so anything
// the column cannot hold must stop here as a 400 rather than surface as a 500.

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BatchUpdateInventoryItemDto } from './batch-update-inventory.dto';

const failedFields = (payload: Record<string, unknown>) =>
  validateSync(
    plainToInstance(BatchUpdateInventoryItemDto, { id: 'part_1', ...payload }),
  )
    .map((e) => e.property)
    .sort();

describe('BatchUpdateInventoryItemDto', () => {
  it('accepts a partial edit', () => {
    expect(failedFields({ retailPrice: 180000 })).toEqual([]);
    expect(failedFields({ stock: 0 })).toEqual([]);
    expect(failedFields({ cashbackPct: 12.5 })).toEqual([]);
  });

  it('lets purchasePrice be cleared: the column means "cost unknown"', () => {
    expect(failedFields({ purchasePrice: null })).toEqual([]);
  });

  it.each(['retailPrice', 'cashbackPct', 'stock'])(
    'rejects null for %s, a NOT NULL column',
    (field) => {
      expect(failedFields({ [field]: null })).toEqual([field]);
    },
  );

  it.each([
    ['retailPrice', 1e12],
    ['purchasePrice', 1e12],
    ['stock', 2_147_483_648],
    ['cashbackPct', 100.01],
  ])('rejects %s = %d, past what the column can hold', (field, value) => {
    expect(failedFields({ [field]: value })).toEqual([field]);
  });

  it.each(['retailPrice', 'purchasePrice', 'cashbackPct', 'stock'])(
    'rejects a negative %s',
    (field) => {
      expect(failedFields({ [field]: -1 })).toEqual([field]);
    },
  );

  it('rejects a retail price of 0: nothing is sold for free', () => {
    expect(failedFields({ retailPrice: 0 })).toEqual(['retailPrice']);
    expect(failedFields({ retailPrice: 0.01 })).toEqual([]);
  });

  it('still allows a purchase price of 0: a cost is not an offer', () => {
    expect(failedFields({ purchasePrice: 0 })).toEqual([]);
  });

  it('rejects a fractional stock count', () => {
    expect(failedFields({ stock: 1.5 })).toEqual(['stock']);
  });
});
