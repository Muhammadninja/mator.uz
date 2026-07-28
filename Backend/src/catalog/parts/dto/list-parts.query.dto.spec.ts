// Contract tests for the buyer parts query DTO, driven through the SAME
// transform+validate pipeline Nest's global ValidationPipe applies. These pin
// the wire format of the motor-oil filters (repeated params, lowercase enums,
// millilitre volumes) and confirm the legacy params are untouched.

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListPartsQueryDto } from './list-parts.query.dto';

/** Run a raw query object through the pipeline; return the DTO and any errors. */
function parse(raw: Record<string, unknown>) {
  const dto = plainToInstance(ListPartsQueryDto, raw);
  const errors = validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors: errors.map((e) => e.property) };
}

describe('ListPartsQueryDto — motor-oil filters', () => {
  it('accepts a single viscosity and normalizes it to an array', () => {
    const { dto, errors } = parse({ viscosity: '5W-30' });
    expect(errors).toEqual([]);
    expect(dto.viscosity).toEqual(['5W-30']);
  });

  it('accepts repeated viscosity params', () => {
    const { dto, errors } = parse({ viscosity: ['5W-30', '0W-20'] });
    expect(errors).toEqual([]);
    expect(dto.viscosity).toEqual(['5W-30', '0W-20']);
  });

  it('accepts a non-preset viscosity (the wizard has a free-text branch)', () => {
    // A seller can enter 0W-16 or 20W-50 via "Другое", so the filter's accepted
    // set must stay open — this is why viscosity is a string, not an enum.
    const { dto, errors } = parse({ viscosity: '0W-16' });
    expect(errors).toEqual([]);
    expect(dto.viscosity).toEqual(['0W-16']);
  });

  it('accepts oil types and drops unknown values instead of rejecting', () => {
    // A stale value from an older client build must not 400 the whole listing —
    // the same rule `region` has always followed.
    const { dto, errors } = parse({ oil_type: ['synthetic', 'bogus'] });
    expect(errors).toEqual([]);
    expect(dto.oil_type).toEqual(['synthetic']);
  });

  it('accepts kinds and drops unknown ones', () => {
    const { dto, errors } = parse({ kind: ['motor_oil', 'nonsense'] });
    expect(errors).toEqual([]);
    expect(dto.kind).toEqual(['motor_oil']);
  });

  it('parses volumes as integers and drops junk / non-positive values', () => {
    const { dto, errors } = parse({ volume_ml: ['4000', 'abc', '-5', '0'] });
    expect(errors).toEqual([]);
    expect(dto.volume_ml).toEqual([4000]);
  });

  it('parses the volume range as numbers', () => {
    const { dto, errors } = parse({
      volume_ml_min: '1000',
      volume_ml_max: '5000',
    });
    expect(errors).toEqual([]);
    expect(dto.volume_ml_min).toBe(1000);
    expect(dto.volume_ml_max).toBe(5000);
  });

  it('rejects a non-integer volume bound', () => {
    const { errors } = parse({ volume_ml_min: 'lots' });
    expect(errors).toContain('volume_ml_min');
  });

  it('rejects an unknown query param (forbidNonWhitelisted contract)', () => {
    const { errors } = parse({ viscosity_typo: '5W-30' });
    expect(errors).toContain('viscosity_typo');
  });
});

describe('ListPartsQueryDto — legacy params still parse unchanged', () => {
  it('keeps the pre-existing spare-part query contract intact', () => {
    const { dto, errors } = parse({
      category: 'BRAKES',
      vehicle_category: 'BRAKE_SYSTEM',
      make: 'Chevrolet',
      model: 'Cobalt',
      brand: 'brand_gates',
      region: ['korea', 'china'],
      gm_only: 'true',
      oem_only: 'true',
      in_stock_only: 'true',
      q: 'фильтр',
      sort: 'price_asc',
      page: '2',
      page_size: '50',
    });
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({
      category: 'BRAKES',
      make: 'Chevrolet',
      region: ['korea', 'china'],
      gm_only: 'true',
      sort: 'price_asc',
      page: 2,
      page_size: 50,
    });
    // No oil filter is invented for a spare-part query.
    expect(dto.kind).toBeUndefined();
    expect(dto.viscosity).toBeUndefined();
    expect(dto.oil_type).toBeUndefined();
    expect(dto.volume_ml).toBeUndefined();
  });

  it('an empty query stays empty (no implicit kind)', () => {
    const { dto, errors } = parse({});
    expect(errors).toEqual([]);
    expect(dto.kind).toBeUndefined();
  });
});
