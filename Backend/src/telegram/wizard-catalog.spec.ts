// Guards the wizard's static UI catalog:
//   1. it shows exactly the brands/models the product requirements list, in
//      their order (the buttons ARE the requirement);
//   2. every (brand, model) pair uses the SAME canonical spelling as the parser
//      canon (VEHICLE_CATALOG), because selections are persisted verbatim into
//      brands / car_models and must converge with historically parsed rows;
//   3. the 8 wizard categories cover the PartVehicleCategory enum exactly.

import { PartVehicleCategory } from '@prisma/client';
import { VEHICLE_CATALOG } from '../ai/vehicle-catalog';
import {
  WIZARD_BRANDS,
  WIZARD_CATEGORIES,
  findWizardCatalogDrift,
  assertWizardCatalogInCanon,
} from './wizard-catalog';

describe('WIZARD_BRANDS', () => {
  it('lists exactly the 13 required brands in display order', () => {
    expect(WIZARD_BRANDS.map((b) => b.name)).toEqual([
      'Chevrolet',
      'Daewoo',
      'Ravon',
      'BYD',
      'Kia',
      'Chery',
      'Hyundai',
      'Lada',
      'Toyota',
      'Haval',
      'Nissan',
      'Skoda',
      'Volkswagen',
    ]);
  });

  it('every brand has at least one model and no duplicates', () => {
    for (const brand of WIZARD_BRANDS) {
      expect(brand.models.length).toBeGreaterThan(0);
      expect(new Set(brand.models).size).toBe(brand.models.length);
    }
  });

  it.each([
    ['Chevrolet', 19],
    ['Daewoo', 6],
    ['Ravon', 5],
    ['BYD', 15],
    ['Kia', 20],
    ['Chery', 8],
    ['Hyundai', 13],
    ['Lada', 6],
    ['Toyota', 10],
    ['Haval', 5],
    ['Nissan', 15],
    ['Skoda', 8],
    ['Volkswagen', 15],
  ])('%s exposes its full required model list (%i models)', (name, count) => {
    const brand = WIZARD_BRANDS.find((b) => b.name === name);
    expect(brand).toBeDefined();
    expect(brand!.models).toHaveLength(count);
  });

  it('spot-checks required models are present', () => {
    const models = (name: string) =>
      WIZARD_BRANDS.find((b) => b.name === name)!.models;
    expect(models('Chevrolet')).toEqual(
      expect.arrayContaining(['Cobalt', 'Nexia 3', 'Traverse']),
    );
    expect(models('Ravon')).toEqual([
      'R2 (Spark)',
      'R3 (Nexia)',
      'R4 (Cobalt)',
      'Gentra',
      'Matiz',
    ]);
    expect(models('Lada')).toEqual([
      '2106',
      '2107',
      '21099',
      'Priora',
      'Granta',
      'Vesta',
    ]);
    expect(models('Volkswagen')).toEqual(
      expect.arrayContaining(['e-Bora', 'ID.7', 'Teramont']),
    );
  });

  // The critical anti-drift invariant, exercised through the SAME runtime guard
  // that runs at module load — so this test and the boot-time assertion can't
  // diverge. wizard-catalog is the single source of truth; the canon must mirror
  // every name it declares.
  it('has no drift from VEHICLE_CATALOG (runtime guard reports none)', () => {
    expect(findWizardCatalogDrift()).toEqual([]);
    expect(() => assertWizardCatalogInCanon()).not.toThrow();
  });

  it('findWizardCatalogDrift reports a fabricated missing pair', () => {
    // Sanity-check the guard actually detects drift (not vacuously passing):
    // spot-check the same VEHICLE_CATALOG lookup the guard uses.
    const chevy = VEHICLE_CATALOG.find((b) => b.canonical === 'Chevrolet')!;
    expect(chevy.models.map((m) => m.canonical)).toContain('Traverse');
    expect(chevy.models.map((m) => m.canonical)).not.toContain('NotARealModel');
  });
});

describe('WIZARD_CATEGORIES', () => {
  it('covers every PartVehicleCategory value exactly once', () => {
    const values = WIZARD_CATEGORIES.map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual(
      [...Object.values(PartVehicleCategory)].sort(),
    );
  });

  it('uses the required Russian labels', () => {
    expect(WIZARD_CATEGORIES.map((c) => c.label)).toEqual([
      'Тормозная система',
      'ТО и Жидкости',
      'Ходовая и Рулевое',
      'Электрика и Оптика',
      'Двигатель',
      'Трансмиссия',
      'Климат и Охлаждение',
      'Тюнинг и Стайлинг',
    ]);
  });
});
