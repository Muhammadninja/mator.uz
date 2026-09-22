import { resolveMake, resolveModel } from './drivers-village-vehicle.mapper';

describe("Driver's Village vehicle mapper", () => {
  it('resolves canonical makes by exact alias, extra makes by the explicit table', () => {
    expect(resolveMake('CHEVROLET')).toEqual({
      make: 'Chevrolet',
      via: 'alias',
      inCanonicalCatalog: true,
    });
    expect(resolveMake(' skoda ')).toMatchObject({ make: 'Skoda' });
    expect(resolveMake('SSANGYONG')).toEqual({
      make: 'SsangYong',
      via: 'table',
      inCanonicalCatalog: false,
    });
  });

  it('rejects a model name used as a make — never guesses', () => {
    expect(resolveMake('COBALT')).toBeNull();
    expect(resolveMake('')).toBeNull();
  });

  it('resolves 1C model codes via exact alias after "-" → " "', () => {
    expect(resolveModel('Chevrolet', 'NEXIA-3')).toEqual({
      model: 'Nexia 3',
      via: 'alias',
      inCanonicalCatalog: true,
    });
    expect(resolveModel('Chevrolet', 'NEXIA 3')).toMatchObject({
      model: 'Nexia 3',
    });
    expect(resolveModel('Chevrolet', 'cobalt')).toMatchObject({
      model: 'Cobalt',
    });
    expect(resolveModel('Ravon', 'R4')).toMatchObject({ model: 'R4 (Cobalt)' });
  });

  it('collapses generation codes into the base model through the explicit table', () => {
    for (const code of ['DAMAS-2', 'DAMAS-3-MOVE'])
      expect(resolveModel('Chevrolet', code)?.model).toBe('Damas');
    expect(resolveModel('Chevrolet', 'MALIBU-1,5-TURBO')).toEqual({
      model: 'Malibu',
      via: 'table',
      inCanonicalCatalog: true,
    });
    expect(resolveModel('Chevrolet', 'EPICA')).toEqual({
      model: 'Epica',
      via: 'table',
      inCanonicalCatalog: false,
    });
  });

  it('returns null for unknown models and for a make repeated as a model', () => {
    expect(resolveModel('Skoda', 'SKODA')).toBeNull();
    expect(resolveModel('Chevrolet', 'MALIBU-2, EQUINOX, CAPTIVA')).toBeNull();
    expect(resolveModel('SsangYong', 'UNKNOWN')).toBeNull();
  });
});
