import {
  canonicalizeBrand,
  canonicalizeModel,
  deriveVehicleCompatibility,
  isUniversalFitment,
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

describe('matchCatalog — a bare numeric token never matches a model (regression: Audi 100)', () => {
  // A purely-numeric model canonical/alias ("100", "80", "2106", "469", …) must
  // NOT be a standalone matchable alias: a stray number in unrelated text would
  // otherwise fabricate a vehicle. Only brand-qualified forms and nicknames match.
  it('a lone "100" in unrelated text does NOT match Audi 100', () => {
    for (const text of ['Масло 100% синтетика', 'Объём 100 мл', 'Фильтр 100']) {
      const r = matchCatalog(text);
      expect(r.brand).toBeNull();
      expect(r.models).toEqual([]);
    }
  });

  it('a lone "80" does NOT match Audi 80', () => {
    const r = matchCatalog('Ресурс 80 тысяч км');
    expect(r.brand).toBeNull();
    expect(r.models).toEqual([]);
  });

  it('bare Russian model numbers ("2106", "412", "469") do NOT match', () => {
    for (const text of ['Партия 2106 штук', 'Код 412', 'Вес 469 г']) {
      const r = matchCatalog(text);
      expect(r.brand).toBeNull();
      expect(r.models).toEqual([]);
    }
  });

  it('an unlabeled part number never matches a model', () => {
    const r = matchCatalog('Фильтр масляный 93745764');
    expect(r.brand).toBeNull();
    expect(r.models).toEqual([]);
  });

  it('brand-qualified and nickname forms of numeric models STILL match', () => {
    expect(matchCatalog('Фара audi 100')).toMatchObject({ brand: 'Audi', models: ['100'] });
    expect(matchCatalog('Фара ауди 100')).toMatchObject({ brand: 'Audi', models: ['100'] });
    expect(matchCatalog('Двигатель сотка')).toMatchObject({ brand: 'Audi', models: ['100'] });
    expect(matchCatalog('Кузов бочка')).toMatchObject({ brand: 'Audi', models: ['80'] });
    expect(matchCatalog('Фара ваз 2106')).toMatchObject({ brand: 'Lada', models: ['2106'] });
    expect(matchCatalog('Двигатель шестерка')).toMatchObject({ brand: 'Lada', models: ['2106'] });
    expect(matchCatalog('Фара москвич 412')).toMatchObject({ brand: 'Moskvich', models: ['412'] });
  });

  it('alphanumeric model codes (E46, X5) are unaffected', () => {
    expect(matchCatalog('Капот e46')).toMatchObject({ brand: 'BMW', models: ['E46'] });
    expect(matchCatalog('Фара x5')).toMatchObject({ brand: 'BMW', models: ['X5'] });
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

describe('Gentra / Lacetti are distinct models (regression: "Lacetti (Gentra)")', () => {
  // Root cause: a single Chevrolet model canonical "Lacetti (Gentra)" bundled the
  // lacetti AND gentra alias families, so both names resolved to the combined
  // string. They are now two separate models resolving to themselves.

  it('Gentra resolves to Gentra (never "Lacetti (Gentra)")', () => {
    expect(canonicalizeModel('gentra')).toBe('Gentra');
    expect(canonicalizeModel('Gentra')).toBe('Gentra');
    expect(matchCatalog('Магнитола Gentra').models).toEqual(['Gentra']);
  });

  it('Lacetti resolves to Lacetti (never "Lacetti (Gentra)")', () => {
    expect(canonicalizeModel('lacetti')).toBe('Lacetti');
    expect(matchCatalog('Фара Lacetti').models).toEqual(['Lacetti']);
  });

  it('neither model is converted into the other', () => {
    expect(canonicalizeModel('gentra')).not.toContain('Lacetti');
    expect(canonicalizeModel('lacetti')).not.toContain('Gentra');
  });

  it('preserves Latin & Cyrillic spelling variants and the gentr abbreviation', () => {
    for (const g of ['gentra', 'джентра', 'гентра', 'жентра', 'jentra', 'gentr']) {
      expect(canonicalizeModel(g)).toBe('Gentra');
    }
    for (const l of ['lacetti', 'лачетти', 'лачети', 'laceti', 'lachetti']) {
      expect(canonicalizeModel(l)).toBe('Lacetti');
    }
  });

  it('detects Cobalt, Gentra and Lacetti as three separate models in one caption', () => {
    const r = matchCatalog('колодки тормозные cobalt gentra lacetti');
    expect(r.brand).toBe('Chevrolet');
    expect(r.models).toEqual(expect.arrayContaining(['Cobalt', 'Gentra', 'Lacetti']));
    expect(r.models).not.toContain('Lacetti (Gentra)');
  });
});

// ── Vehicle compatibility: per-model brand pairs ─────────────────────────────
describe('matchCatalog — (brand, model) pairs', () => {
  it('pairs a single model with its inferred brand', () => {
    const r = matchCatalog('бампер cobalt');
    expect(r.vehicles).toEqual([{ brand: 'Chevrolet', model: 'Cobalt' }]);
  });

  it('cross-brand caption keeps each model under ITS OWN brand', () => {
    const r = matchCatalog('стойка cobalt / solaris');
    expect(r.vehicles).toHaveLength(2);
    expect(r.vehicles).toEqual(
      expect.arrayContaining([
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Hyundai', model: 'Solaris' },
      ]),
    );
  });

  it('explicit brands pair with their own models (Chevrolet Cobalt, Hyundai Solaris)', () => {
    const r = matchCatalog('chevrolet cobalt, hyundai solaris');
    expect(r.brands).toEqual(expect.arrayContaining(['Chevrolet', 'Hyundai']));
    expect(r.vehicles).toEqual(
      expect.arrayContaining([
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Hyundai', model: 'Solaris' },
      ]),
    );
  });

  it('an explicit brand that owns a shared model wins (Daewoo Matiz stays Daewoo)', () => {
    const r = matchCatalog('фара daewoo matiz');
    expect(r.vehicles).toEqual([{ brand: 'Daewoo', model: 'Matiz' }]);
  });

  it('a shared model with no explicit brand falls to the first catalog owner', () => {
    const r = matchCatalog('фара matiz');
    expect(r.vehicles).toEqual([{ brand: 'Chevrolet', model: 'Matiz' }]);
  });

  it('mixed explicit/implicit brands (Gentra, Kia Rio)', () => {
    const r = matchCatalog('прокладка gentra, kia rio');
    expect(r.vehicles).toEqual(
      expect.arrayContaining([
        { brand: 'Chevrolet', model: 'Gentra' },
        { brand: 'Kia', model: 'Rio' },
      ]),
    );
  });
});

// ── Universal fitment detection ──────────────────────────────────────────────
describe('isUniversalFitment', () => {
  it.each([
    'Универсальный',
    'универсальные коврики',
    'Для всех автомобилей',
    'Подходит ко всем автомобилям',
    'подходит на все машины',
    'Любые марки',
    'Любые модели',
    'Ко всем маркам',
    'Ко всем моделям',
    'Universal',
    'Fits all vehicles',
    'fits all cars',
    'All models',
    'All cars',
    'barcha avtomobillarga mos',
  ])('detects universal claim in "%s"', (text) => {
    expect(isUniversalFitment(text)).toBe(true);
  });

  it.each([
    'Бампер Cobalt',
    'фильтр масляный 96535062',
    'все детали в наличии', // "все" without a vehicle noun
    'вселенная', // "все…" as a word prefix, not the standalone word
  ])('does not fire on ordinary text "%s"', (text) => {
    expect(isUniversalFitment(text)).toBe(false);
  });
});

// ── deriveVehicleCompatibility: union of title + description ─────────────────
describe('deriveVehicleCompatibility', () => {
  it('merges models split between title and description (union, deduplicated)', () => {
    const r = deriveVehicleCompatibility(['Бампер Cobalt', 'Подходит также Gentra и Lacetti']);
    expect(r.isUniversal).toBe(false);
    expect(r.vehicles).toHaveLength(3);
    expect(r.vehicles).toEqual(
      expect.arrayContaining([
        { brand: 'Chevrolet', model: 'Cobalt' },
        { brand: 'Chevrolet', model: 'Gentra' },
        { brand: 'Chevrolet', model: 'Lacetti' },
      ]),
    );
    expect(r.models).toEqual(expect.arrayContaining(['Cobalt', 'Gentra', 'Lacetti']));
    expect(r.brand).toBe('Chevrolet');
  });

  it('duplicate mentions across chunks collapse to one pair', () => {
    const r = deriveVehicleCompatibility(['Фара Cobalt', 'для Cobalt (кобальт)']);
    expect(r.vehicles).toEqual([{ brand: 'Chevrolet', model: 'Cobalt' }]);
    expect(r.models).toEqual(['Cobalt']);
  });

  it('universal claim wins over any model mention (highest priority)', () => {
    const r = deriveVehicleCompatibility(['Универсальные коврики', 'подходят на Cobalt']);
    expect(r).toEqual({ isUniversal: true, vehicles: [], brand: null, models: [] });
  });

  it('universal claim in the description alone also wins', () => {
    const r = deriveVehicleCompatibility(['Ароматизатор', 'Для всех автомобилей']);
    expect(r.isUniversal).toBe(true);
    expect(r.vehicles).toEqual([]);
  });

  it('folds extra (AI) models into the union with catalog-resolved brands', () => {
    const r = deriveVehicleCompatibility(['Патрубок'], {
      brand: 'Chevrolet',
      models: ['кобальт', 'Solaris'],
    });
    expect(r.vehicles).toEqual([
      { brand: 'Chevrolet', model: 'Cobalt' },
      { brand: 'Hyundai', model: 'Solaris' }, // catalog owner beats the AI brand
    ]);
  });

  it('returns empty result for chunks with no vehicles', () => {
    const r = deriveVehicleCompatibility(['Фильтр масляный', null, undefined]);
    expect(r).toEqual({ isUniversal: false, vehicles: [], brand: null, models: [] });
  });
});
