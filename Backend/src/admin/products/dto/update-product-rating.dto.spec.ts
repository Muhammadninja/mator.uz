// Validation tests for UpdateProductRatingDto — the API contract for curated
// ratings. Run through the same class-transformer + class-validator pipeline the
// global ValidationPipe uses, so what passes here is exactly what the endpoint
// accepts.

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateProductRatingDto } from './update-product-rating.dto';

/** Validate a raw body exactly as the global ValidationPipe would. */
function errorsFor(body: unknown): string[] {
  const dto = plainToInstance(UpdateProductRatingDto, body, {
    enableImplicitConversion: false,
  });
  return validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);
}

describe('UpdateProductRatingDto', () => {
  describe('accepts', () => {
    it.each([
      ['zero', { ratingAvg: 0, reviewCount: 1 }],
      ['one decimal place', { ratingAvg: 1.0, reviewCount: 0 }],
      ['a typical curated value', { ratingAvg: 4.7, reviewCount: 123 }],
      ['the maximum', { ratingAvg: 5.0, reviewCount: 0 }],
      [
        'an explicit null (clears the rating)',
        { ratingAvg: null, reviewCount: 0 },
      ],
      ['only reviewCount', { reviewCount: 10 }],
      ['only ratingAvg', { ratingAvg: 3.5 }],
    ])('%s', (_label, body) => {
      expect(errorsFor(body)).toEqual([]);
    });
  });

  describe('rejects', () => {
    it.each([
      ['a negative rating', { ratingAvg: -1 }, 'ratingAvg'],
      ['a rating just below zero', { ratingAvg: -0.1 }, 'ratingAvg'],
      ['a rating above five', { ratingAvg: 5.1 }, 'ratingAvg'],
      ['an integer above five', { ratingAvg: 6 }, 'ratingAvg'],
      // The Decimal(2,1) contract: a second decimal place cannot be stored, so
      // it is a 400 rather than a value silently rounded into the column.
      ['two decimal places', { ratingAvg: 4.75 }, 'ratingAvg'],
      ['a negative reviewCount', { reviewCount: -1 }, 'reviewCount'],
      ['a fractional reviewCount', { reviewCount: 1.5 }, 'reviewCount'],
    ])('%s', (_label, body, property) => {
      expect(errorsFor(body)).toContain(property);
    });
  });
});
