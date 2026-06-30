import {
  canonicalizeBrand,
  canonicalizeModel,
  matchCatalog,
} from './vehicle-catalog';

describe('matchCatalog', () => {
  it('finds a model and infers its brand', () => {
    const r = matchCatalog('фильтр cobalt');
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(['Cobalt']);
  });

  it('matches the longest model alias first (Nexia 3 over Nexia)', () => {
    const r = matchCatalog('диск nexia 3');
    expect(r.models).toContain('Nexia 3');
    expect(r.models).not.toContain('Nexia');
  });

  it('detects an explicit brand even with no model', () => {
    const r = matchCatalog('фара hyundai');
    expect(r.brand).toBe('Hyundai');
    expect(r.models).toEqual([]);
  });

  it('matches cyrillic aliases', () => {
    const r = matchCatalog('бампер кобальт');
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(['Cobalt']);
  });

  it('does not match substrings inside larger words', () => {
    // "rio" must not match inside "priora"
    const r = matchCatalog('priora фильтр');
    expect(r.models).not.toContain('Rio');
  });

  it('returns nothing for junk', () => {
    const r = matchCatalog('HShshdh');
    expect(r.brand).toBeNull();
    expect(r.models).toEqual([]);
  });
});

describe('matchCatalog — extended brand set', () => {
  it('matches Mercedes chassis codes and infers the brand', () => {
    const r = matchCatalog('капот w124');
    expect(r.brand).toBe('Mercedes-Benz');
    expect(r.models).toContain('W124');
  });

  it('matches longest Mercedes alias first (GLE Coupe over GLE)', () => {
    const r = matchCatalog('фара gle coupe');
    expect(r.models).toContain('GLE Coupe');
    expect(r.models).not.toContain('GLE');
  });

  it('matches alphanumeric BMW model codes', () => {
    const r = matchCatalog('двигатель e46 bmw');
    expect(r.brand).toBe('BMW');
    expect(r.models).toContain('E46');
  });

  it('matches Audi codes and infers the brand', () => {
    const r = matchCatalog('фара q7');
    expect(r.brand).toBe('Audi');
    expect(r.models).toContain('Q7');
  });

  it('matches BYD multi-word models', () => {
    const r = matchCatalog('бампер song plus');
    expect(r.brand).toBe('BYD');
    expect(r.models).toContain('Song Plus');
  });

  it('matches Mazda CX models with the dash', () => {
    const r = matchCatalog('диск cx-5');
    expect(r.brand).toBe('Mazda');
    expect(r.models).toContain('CX-5');
  });

  it('matches Nissan X-Trail variants', () => {
    expect(matchCatalog('фара x-trail').models).toContain('X-Trail');
    expect(matchCatalog('фара xtrail').models).toContain('X-Trail');
  });

  it('matches new Kia and Hyundai models', () => {
    expect(matchCatalog('бампер seltos').brand).toBe('Kia');
    expect(matchCatalog('бампер palisade').brand).toBe('Hyundai');
    expect(matchCatalog('фара ioniq 5').models).toContain('Ioniq 5');
  });

  it('matches longest Changan alias first (CS75 Plus over noise)', () => {
    const r = matchCatalog('решетка cs75 plus');
    expect(r.brand).toBe('Changan');
    expect(r.models).toContain('CS75 Plus');
  });

  it('resolves a bare shared code to the first brand (Haval before Hongqi)', () => {
    // "h6" is shared; Haval is earlier in the catalog, so bare h6 → Haval.
    const r = matchCatalog('фильтр h6');
    expect(r.brand).toBe('Haval');
    expect(r.models).toContain('H6');
  });
});

describe('matchCatalog — newest brand set', () => {
  it('treats "range rover" as a Land Rover model and infers the brand', () => {
    const r = matchCatalog('фара range rover');
    expect(r.brand).toBe('Land Rover');
    expect(r.models).toContain('Range Rover');
  });

  it('matches longer Range Rover variants over the bare name', () => {
    const r = matchCatalog('бампер range rover sport');
    expect(r.models).toContain('Range Rover Sport');
    expect(r.models).not.toContain('Range Rover');
  });

  it('disambiguates Toyota Land Cruiser variants by suffix', () => {
    expect(matchCatalog('фара land cruiser 300').models).toContain('Land Cruiser 300');
    expect(matchCatalog('фара land cruiser 300').models).not.toContain('Land Cruiser');
    expect(matchCatalog('фара land cruiser prado').models).toContain('Land Cruiser Prado');
  });

  it('matches Renault, Skoda, Tesla, Volvo models', () => {
    expect(matchCatalog('фильтр duster').brand).toBe('Renault');
    expect(matchCatalog('фильтр octavia').brand).toBe('Skoda');
    expect(matchCatalog('диск model y').models).toContain('Model Y');
    expect(matchCatalog('фара xc90').brand).toBe('Volvo');
  });

  it('matches cyrillic-only CIS brands', () => {
    expect(matchCatalog('бампер приора').brand).toBe('Lada');
    expect(matchCatalog('двигатель газель').brand).toBe('GAZ');
    expect(matchCatalog('фара уаз патриот').brand).toBe('UAZ');
    expect(matchCatalog('фара уаз патриот').models).toContain('Patriot');
  });

  it('matches Xiaomi SU7 variants longest-first', () => {
    expect(matchCatalog('бампер su7 max').models).toContain('SU7 Max');
    expect(matchCatalog('бампер su7 max').models).not.toContain('SU7');
  });

  it('matches new Toyota/VW models', () => {
    expect(matchCatalog('фара corolla cross').models).toContain('Corolla Cross');
    expect(matchCatalog('фара teramont').brand).toBe('Volkswagen');
    expect(matchCatalog('фара id.4').models).toContain('ID.4');
  });
});

describe('canonicalize', () => {
  it('canonicalizes brand aliases', () => {
    expect(canonicalizeBrand('шевроле')).toBe('Chevrolet');
    expect(canonicalizeBrand('CHEVROLET')).toBe('Chevrolet');
  });

  it('keeps unknown brands as trimmed input', () => {
    expect(canonicalizeBrand('  Tesla ')).toBe('Tesla');
    expect(canonicalizeBrand(null)).toBeNull();
    expect(canonicalizeBrand('   ')).toBeNull();
  });

  it('canonicalizes model aliases', () => {
    expect(canonicalizeModel('кобальт')).toBe('Cobalt');
    expect(canonicalizeModel('gentr')).toBe('Gentra');
    expect(canonicalizeModel('UnknownModel')).toBe('UnknownModel');
  });
});
