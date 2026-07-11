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

  // ── JAPAN as a first-class origin region ──────────────────────────────────
  it('Japanese make Toyota with no keyword → JAPAN', () => {
    expect(classifyPart('Колодки Toyota Camry', null).originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('Japanese make Honda → JAPAN', () => {
    expect(classifyPart('Фильтр Honda Civic', null).originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('Japanese make Nissan → JAPAN', () => {
    expect(classifyPart('Амортизатор Nissan Teana', null).originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('Japanese make Lexus → JAPAN', () => {
    expect(classifyPart('Фара Lexus RX', null).originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('Japanese make Mazda → JAPAN', () => {
    expect(classifyPart('Ремень Mazda 6', null).originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('Japanese make Mitsubishi → JAPAN', () => {
    expect(classifyPart('Колодки Mitsubishi', null).originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('explicit Япония keyword → JAPAN', () => {
    expect(classifyPart('Свеча Япония', null).originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('explicit "made in Japan" → JAPAN', () => {
    expect(classifyPart('Spark plug made in Japan', null).originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('Korean makes still map to KOREA (unchanged)', () => {
    expect(classifyPart('Фильтр Hyundai Solaris', null).originRegion).toBe(PartOriginRegion.KOREA);
    expect(classifyPart('Колодки Kia K5', null).originRegion).toBe(PartOriginRegion.KOREA);
  });

  // The rarer Japanese makes must be detected from the DICTIONARY (make), not
  // only from a "Japan" keyword in the text.
  it.each([
    ['Колодки Subaru Forester', 'Subaru'],
    ['Фильтр Suzuki Swift', 'Suzuki'],
    ['Амортизатор Infiniti QX50', 'Infiniti'],
    ['Ремень Acura MDX', 'Acura'],
    ['Фара Daihatsu Terios', 'Daihatsu'],
    ['Тормоза Isuzu D-Max', 'Isuzu'],
  ])('%s → make detected and region JAPAN (no "Japan" keyword)', (text, make) => {
    const r = classifyPart(text, null);
    expect(r.make).toBe(make);
    expect(r.originRegion).toBe(PartOriginRegion.JAPAN);
  });

  // ── is_gm: describes the PART, from explicit evidence only ─────────────────
  it('GM vehicle make alone does NOT set isGm (Chevrolet part is not a GM part)', () => {
    expect(classifyPart('Фара Chevrolet Cobalt', null).isGm).toBe(false);
  });

  it('non-GM make → isGm false', () => {
    expect(classifyPart('Фара BMW X5', null).isGm).toBe(false);
  });

  it('explicit "General Motors" in text → isGm true', () => {
    expect(classifyPart('Ремень General Motors', null).isGm).toBe(true);
  });

  it('ACDelco (GM parts brand) → isGm true', () => {
    expect(classifyPart('Фильтр ACDelco', null).isGm).toBe(true);
  });

  it('standalone GM token in text → isGm true', () => {
    expect(classifyPart('Колодки GM оригинал', null).isGm).toBe(true);
  });

  it('GM label on the OEM number → isGm true', () => {
    expect(classifyPart('Ремень генератора', null, 'GM 96440756').isGm).toBe(true);
  });

  it('plain numeric OEM with no GM marker → isGm false', () => {
    expect(classifyPart('Ремень генератора', null, '96440756').isGm).toBe(false);
  });

  it('GM substring inside a word does NOT trigger isGm', () => {
    // "программа" contains no GM token; ensure no false positive on partials.
    expect(classifyPart('Программатор ключей', null).isGm).toBe(false);
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

  // ── OEM and GM are INDEPENDENT dimensions (OEM ≠ GM) ───────────────────────
  it('Denso for Toyota is OEM but NOT GM (an OEM supplier is not GM)', () => {
    const r = classifyPart('Свеча Denso оригинал Toyota Camry', null);
    expect(r.isOem).toBe(true);
    expect(r.isGm).toBe(false);
    expect(r.originRegion).toBe(PartOriginRegion.JAPAN);
  });

  it('ACDelco is GM but NOT OEM here (no OEM/original keyword present)', () => {
    const r = classifyPart('Фильтр ACDelco', null);
    expect(r.isGm).toBe(true);
    expect(r.isOem).toBe(false);
  });

  it('a GM Genuine original part is BOTH GM and OEM', () => {
    const r = classifyPart('GM Genuine оригинал', null);
    expect(r.isGm).toBe(true);
    expect(r.isOem).toBe(true);
  });
});
