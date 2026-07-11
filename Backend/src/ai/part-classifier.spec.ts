// Tests for classifyPart: multilingual (RU / UZ / EN) category classification
// plus region-of-origin, OEM and GM inference. Every listing gets a main +
// vehicle category (fallback when unsure), so the result is never empty.

import { PartMainCategory, PartVehicleCategory, PartOriginRegion } from '@prisma/client';
import { classifyPart } from './part-classifier';

describe('classifyPart — category (RU / UZ / EN)', () => {
  it('Russian: тормозные колодки → Brakes / Brake System', () => {
    const r = classifyPart('Тормозные колодки передние', 'Оригинал');
    expect(r.mainCategory).toBe(PartMainCategory.BRAKES);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.BRAKE_SYSTEM);
  });

  it('Uzbek: tormoz kolodka → Brakes / Brake System', () => {
    const r = classifyPart('Tormoz kolodka old', null);
    expect(r.mainCategory).toBe(PartMainCategory.BRAKES);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.BRAKE_SYSTEM);
  });

  it('English: brake pads → Brakes / Brake System', () => {
    const r = classifyPart('Front brake pads', 'OEM quality');
    expect(r.mainCategory).toBe(PartMainCategory.BRAKES);
  });

  it('Russian: аккумулятор → Batteries / Electrical & Lighting', () => {
    const r = classifyPart('Аккумулятор 60Ah', null);
    expect(r.mainCategory).toBe(PartMainCategory.BATTERIES);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.ELECTRICAL_AND_LIGHTING);
  });

  it('Russian: масляный фильтр → Filters / Maintenance & Fluids', () => {
    const r = classifyPart('Фильтр масляный Cobalt', null);
    expect(r.mainCategory).toBe(PartMainCategory.FILTERS);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.MAINTENANCE_AND_FLUIDS);
  });

  it('Russian: свечи зажигания → Ignition / Engine', () => {
    const r = classifyPart('Свечи зажигания NGK', null);
    expect(r.mainCategory).toBe(PartMainCategory.IGNITION);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.ENGINE);
  });

  it('Russian: генератор → Electrical Parts / Electrical & Lighting', () => {
    const r = classifyPart('Генератор Chevrolet Cobalt', null);
    expect(r.mainCategory).toBe(PartMainCategory.ELECTRICAL_PARTS);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.ELECTRICAL_AND_LIGHTING);
  });

  it('Russian: моторное масло → Oil & Fluids / Maintenance & Fluids', () => {
    const r = classifyPart('Масло моторное 5W40', null);
    expect(r.mainCategory).toBe(PartMainCategory.OIL_AND_FLUIDS);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.MAINTENANCE_AND_FLUIDS);
  });

  it('Russian: приводной ремень → Belts & Hoses / Engine', () => {
    const r = classifyPart('Ремень генератора', null);
    expect(r.mainCategory).toBe(PartMainCategory.BELTS_AND_HOSES);
  });

  it('English: wiper blades → Wipers', () => {
    const r = classifyPart('Wiper blades set', null);
    expect(r.mainCategory).toBe(PartMainCategory.WIPERS);
  });

  it('Russian: фары → Lighting / Electrical & Lighting', () => {
    const r = classifyPart('Фара передняя левая', null);
    expect(r.mainCategory).toBe(PartMainCategory.LIGHTING);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.ELECTRICAL_AND_LIGHTING);
  });

  it('Russian: амортизатор → Suspension / Suspension & Steering', () => {
    const r = classifyPart('Амортизатор передний', null);
    expect(r.mainCategory).toBe(PartMainCategory.SUSPENSION);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.SUSPENSION_AND_STEERING);
  });

  it('Russian: бампер → Exterior / Tuning & Accessories', () => {
    const r = classifyPart('Бампер передний', null);
    expect(r.mainCategory).toBe(PartMainCategory.EXTERIOR);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.TUNING_AND_ACCESSORIES);
  });

  it('Russian: коробка передач → Transmission (vehicle) / Engine (main)', () => {
    const r = classifyPart('АКПП в сборе', null);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.TRANSMISSION);
  });

  it('Russian: радиатор → Heating & Cooling (vehicle)', () => {
    const r = classifyPart('Радиатор охлаждения', null);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.HEATING_AND_COOLING);
  });

  it('classifies from the DESCRIPTION when the title is generic', () => {
    const r = classifyPart('Запчасть для авто', 'Тормозные колодки задние');
    expect(r.mainCategory).toBe(PartMainCategory.BRAKES);
  });

  it('never returns empty — unknown text falls back to Engine / Engine', () => {
    const r = classifyPart('абвгд', null);
    expect(r.mainCategory).toBe(PartMainCategory.ENGINE);
    expect(r.vehicleCategory).toBe(PartVehicleCategory.ENGINE);
  });
});

describe('classifyPart — region, GM and OEM', () => {
  it('explicit Xitoy (Uzbek) → CHINA', () => {
    expect(classifyPart('Bamper Xitoy', null).originRegion).toBe(PartOriginRegion.CHINA);
  });

  it('explicit Корея (Russian) → KOREA', () => {
    expect(classifyPart('Фильтр Корея', null).originRegion).toBe(PartOriginRegion.KOREA);
  });

  it('no region keyword → falls back to the make home market (Chevrolet → USA)', () => {
    expect(classifyPart('Колодки Chevrolet Cobalt', null).originRegion).toBe(PartOriginRegion.USA);
  });

  it('BYD (Chinese make) with no keyword → CHINA', () => {
    expect(classifyPart('Тормозные диски BYD', null).originRegion).toBe(PartOriginRegion.CHINA);
  });

  it('explicit keyword overrides the make market (Chevrolet part, но Китай → CHINA)', () => {
    expect(classifyPart('Ремень Chevrolet Китай', null).originRegion).toBe(PartOriginRegion.CHINA);
  });

  it('no make and no keyword → region null', () => {
    expect(classifyPart('Универсальный коврик', null).originRegion).toBeNull();
  });

  it('GM make (Chevrolet) → isGm true', () => {
    expect(classifyPart('Фара Chevrolet Cobalt', null).isGm).toBe(true);
  });

  it('non-GM make (BMW) → isGm false', () => {
    expect(classifyPart('Фара BMW X5', null).isGm).toBe(false);
  });

  it('оригинал → isOem true', () => {
    expect(classifyPart('Колодки оригинал', null).isOem).toBe(true);
  });

  it('OEM keyword → isOem true', () => {
    expect(classifyPart('Brake pads OEM', null).isOem).toBe(true);
  });

  it('no OEM keyword → isOem false', () => {
    expect(classifyPart('Колодки Xitoy', null).isOem).toBe(false);
  });
});
