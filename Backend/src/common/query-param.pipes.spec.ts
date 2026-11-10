// LOW-CAT-009: repeated, array and oversized query parameters are a 400.

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { BoundedIntQueryPipe, ScalarQueryPipe } from './query-param.pipes';
import { ListPartsQueryDto } from '../catalog/parts/dto/list-parts.query.dto';
import { LegalDocumentVersionParamsDto } from '../legal/dto/legal-document-version.params.dto';

describe('ScalarQueryPipe', () => {
  const pipe = new ScalarQueryPipe('q', 10);

  it('passes one string through, and absence as undefined', () => {
    expect(pipe.transform('brake')).toBe('brake');
    expect(pipe.transform(undefined)).toBeUndefined();
  });

  it.each([
    ['?q=a&q=b', ['a', 'b']],
    ['?q[x]=1', { x: '1' }],
    ['a number from a custom parser', 5],
  ])('refuses %s with 400', (_what, value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });

  it('refuses an oversized value', () => {
    expect(() => pipe.transform('x'.repeat(11))).toThrow(/at most 10/);
  });
});

describe('BoundedIntQueryPipe', () => {
  const pipe = new BoundedIntQueryPipe('page', 1, 100, 1);
  it('reads a bounded integer and defaults when absent', () => {
    expect(pipe.transform('7')).toBe(7);
    expect(pipe.transform(undefined)).toBe(1);
  });
  it.each(['0', '101', '-1', '1e3', '9999999999', 'abc', ['1', '2']])(
    'refuses %j',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    },
  );
});

describe('DTO-validated public queries', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const parts = (query: Record<string, unknown>) =>
    pipe.transform(query, { type: 'query', metatype: ListPartsQueryDto });

  it('keeps every normal mobile query working', async () => {
    await expect(
      parts({
        q: 'колодки',
        vehicle_category: 'BRAKE_SYSTEM',
        page: '2',
        page_size: '20',
        sort: 'price_asc',
        region: ['korea', 'europe'],
        volume_ml: ['1000', '4000'],
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['repeated q', { q: ['a', 'b'] }],
    ['repeated vehicle_id', { vehicle_id: ['v1', 'v2'] }],
    ['oversized q', { q: 'x'.repeat(201) }],
    ['an excessive page', { page: '10001' }],
    ['a zero page', { page: '0' }],
    ['an oversized page size', { page_size: '500' }],
  ])('refuses %s with 400', async (_what, query) => {
    await expect(parts(query)).rejects.toMatchObject({ status: 400 });
  });

  it('bounds the legal document version', async () => {
    const run = (version: string) =>
      pipe.transform(
        { type: 'PRIVACY_POLICY', version },
        { type: 'param', metatype: LegalDocumentVersionParamsDto },
      );
    await expect(run('3')).resolves.toBeDefined();
    await expect(run('99999999999')).rejects.toMatchObject({ status: 400 });
  });
});
