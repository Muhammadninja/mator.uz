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
    for (const code of ['TRACKER-1', 'TRACKER-2'])
      expect(resolveModel('Chevrolet', code)).toEqual({
        model: 'Tracker',
        via: 'table',
        inCanonicalCatalog: true,
      });
    expect(resolveModel('Chevrolet', 'MALIBU-2')?.model).toBe('Malibu');
    expect(resolveModel('Chevrolet', 'EPICA')).toEqual({
      model: 'Epica',
      via: 'table',
      inCanonicalCatalog: false,
    });
  });

  it('treats a space and a dash in a table code as the same separator', () => {
    expect(resolveModel('Chevrolet', 'CAPTIVA 5')?.model).toBe('Captiva');
    expect(resolveModel('Chevrolet', 'CAPTIVA-5')?.model).toBe('Captiva');
    expect(resolveModel('Chevrolet', 'TAHOE 2')?.model).toBe('Tahoe');
    expect(resolveModel('Chevrolet', 'NEXIA 1')).toEqual({
      model: 'Nexia 1',
      via: 'table',
      inCanonicalCatalog: false,
    });
  });

  it('matches an alias that itself contains a dash (Hyundai H-1)', () => {
    expect(resolveModel('Hyundai', 'H-1')).toEqual({
      model: 'H-1',
      via: 'alias',
      inCanonicalCatalog: true,
    });
  });

  it('maps the models the canonical catalog does not list through the table', () => {
    expect(resolveModel('Chevrolet', 'MONZA')?.model).toBe('Monza');
    expect(resolveModel('Lada', 'NIVA')?.model).toBe('Niva');
    expect(resolveModel('Lada', 'LARGUS')?.model).toBe('Largus');
    expect(resolveModel('SsangYong', 'TIVOLI')).toEqual({
      model: 'Tivoli',
      via: 'table',
      inCanonicalCatalog: false,
    });
  });

  it('returns null for unknown models and for a make repeated as a model', () => {
    expect(resolveModel('Skoda', 'SKODA')).toBeNull();
    expect(resolveModel('SsangYong', 'UNKNOWN')).toBeNull();
    // Never guessed: Tico is Daewoo's, a bare "NEXIA" names no generation.
    expect(resolveModel('Chevrolet', 'TICO')).toBeNull();
    expect(resolveModel('Chevrolet', 'NEXIA')).toBeNull();
  });
});
