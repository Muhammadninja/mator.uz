// src/ai/part-classifier.ts
//
// Rule-based, multilingual classifier that derives the stored catalog attributes
// from a listing's title + description:
//   • main category      (PartMainCategory, 12 home-page buckets)
//   • vehicle category    (PartVehicleCategory, 8 make/model buckets)
//   • region of origin    (PartOriginRegion: CHINA/EUROPE/RUSSIA/KOREA/USA)
//   • OEM quality flag     (original / zavod / OEM)
//   • GM-only flag         (make ∈ Chevrolet / Ravon / Daewoo)
//
// Design goals (mirrors the part-parser's rule-based layer, offline only):
//   • Works across Russian, Uzbek (latin + cyrillic) and English + abbreviations.
//   • Scores keyword hits rather than requiring exact matches, so a synonym or a
//     partial term still classifies. The highest-scoring category wins.
//   • ALWAYS returns a main + vehicle category: when no keyword is confident the
//     fallback (Engine / Maintenance) is used — the result is never empty.
//
// Make/model themselves are extracted by the existing matchCatalog (vehicle-
// catalog.ts); this module reuses that for region/GM inference.

import { PartMainCategory, PartVehicleCategory, PartOriginRegion } from '@prisma/client';
import { matchCatalog } from './vehicle-catalog';

export interface PartClassification {
  mainCategory: PartMainCategory;
  vehicleCategory: PartVehicleCategory;
  originRegion: PartOriginRegion | null;
  isOem: boolean;
  isGm: boolean;
  /** Canonical vehicle make (first detected), or null — convenience for callers. */
  make: string | null;
}

// Fallbacks when nothing scores. Engine + Maintenance are the broadest,
// least-wrong buckets for an unclassifiable auto part.
const FALLBACK_MAIN: PartMainCategory = PartMainCategory.ENGINE;
const FALLBACK_VEHICLE: PartVehicleCategory = PartVehicleCategory.ENGINE;

// GM-family makes (canonical names from vehicle-catalog). The contract's
// `gm_only` restricts to these.
const GM_MAKES = new Set(['Chevrolet', 'Ravon', 'Daewoo']);

// Home market per canonical make → region of origin. Used to infer originRegion
// from the detected make when the text has no explicit origin keyword.
const MAKE_REGION: Record<string, PartOriginRegion> = {
  Chevrolet: PartOriginRegion.USA,
  Daewoo: PartOriginRegion.KOREA,
  Ravon: PartOriginRegion.USA, // GM-Uzbekistan platform (US/GM lineage)
  Hyundai: PartOriginRegion.KOREA,
  Kia: PartOriginRegion.KOREA,
  Toyota: PartOriginRegion.KOREA, // JP not in the enum; nearest supported market
  Ford: PartOriginRegion.USA,
  Tesla: PartOriginRegion.USA,
  BYD: PartOriginRegion.CHINA,
  Chery: PartOriginRegion.CHINA,
  Geely: PartOriginRegion.CHINA,
  Haval: PartOriginRegion.CHINA,
  Changan: PartOriginRegion.CHINA,
  Dongfeng: PartOriginRegion.CHINA,
  GAC: PartOriginRegion.CHINA,
  JAC: PartOriginRegion.CHINA,
  Jetour: PartOriginRegion.CHINA,
  Leapmotor: PartOriginRegion.CHINA,
  'Li Auto': PartOriginRegion.CHINA,
  Hongqi: PartOriginRegion.CHINA,
  Omoda: PartOriginRegion.CHINA,
  Voyah: PartOriginRegion.CHINA,
  Xiaomi: PartOriginRegion.CHINA,
  Zeekr: PartOriginRegion.CHINA,
  Volkswagen: PartOriginRegion.EUROPE,
  BMW: PartOriginRegion.EUROPE,
  'Mercedes-Benz': PartOriginRegion.EUROPE,
  Audi: PartOriginRegion.EUROPE,
  Opel: PartOriginRegion.EUROPE,
  Skoda: PartOriginRegion.EUROPE,
  Volvo: PartOriginRegion.EUROPE,
  Renault: PartOriginRegion.EUROPE,
  'Land Rover': PartOriginRegion.EUROPE,
  Lexus: PartOriginRegion.KOREA, // JP not supported; nearest market
  Mazda: PartOriginRegion.KOREA,
  Nissan: PartOriginRegion.KOREA,
  Honda: PartOriginRegion.KOREA,
  Mitsubishi: PartOriginRegion.KOREA,
  Lada: PartOriginRegion.RUSSIA,
  GAZ: PartOriginRegion.RUSSIA,
  ZAZ: PartOriginRegion.RUSSIA,
  IZh: PartOriginRegion.RUSSIA,
  Moskvich: PartOriginRegion.RUSSIA,
  UAZ: PartOriginRegion.RUSSIA,
};

// Explicit origin keywords (RU / UZ-latin / EN), scored against the text.
const REGION_KEYWORDS: Record<PartOriginRegion, string[]> = {
  [PartOriginRegion.CHINA]: ['китай', 'китайск', 'xitoy', 'xitoyda', 'china', 'chinese', 'кнр'],
  [PartOriginRegion.KOREA]: ['корея', 'корейск', 'koreya', 'korea', 'korean', 'koreys'],
  [PartOriginRegion.EUROPE]: ['европа', 'европейск', 'yevropa', 'europe', 'european', 'германия', 'germaniya', 'germany', 'польша', 'polsha', 'poland'],
  [PartOriginRegion.RUSSIA]: ['россия', 'российск', 'rossiya', 'russia', 'russian', 'рф'],
  [PartOriginRegion.USA]: ['сша', 'америка', 'американск', 'amerika', 'usa', 'american', 'ссша'],
};

// OEM / original quality keywords. "OEM" and "zavod/завод" (factory) count too.
const OEM_KEYWORDS = ['оригинал', 'ориг', 'original', 'orginal', 'oem', 'zavod', 'завод', 'заводск', 'zavodskoy', 'asl', 'haqiqiy'];

// ── Category taxonomy ───────────────────────────────────────────────────────
// Each entry maps a part concept to a (main, vehicle) category pair and the
// multilingual keywords that signal it. Keywords are lowercase; matching is
// substring-based and scored (a longer, more specific keyword scores higher),
// so synonyms and partial forms still classify without exact matches.
interface CategoryRule {
  main: PartMainCategory;
  vehicle: PartVehicleCategory;
  keywords: string[];
}

const CATEGORY_RULES: CategoryRule[] = [
  // Brakes → Brake System
  {
    main: PartMainCategory.BRAKES,
    vehicle: PartVehicleCategory.BRAKE_SYSTEM,
    keywords: [
      'тормоз', 'колодк', 'тормозн', 'суппорт', 'тормозной диск', 'ручник',
      'brake', 'brakes', 'brake pad', 'brake disc', 'caliper', 'rotor',
      'tormoz', 'koloska', 'kolodka', 'suppurt', 'disk tormoz',
    ],
  },
  // Batteries → Electrical & Lighting
  {
    main: PartMainCategory.BATTERIES,
    vehicle: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
    keywords: [
      'аккумулятор', 'акум', 'акб', 'аккум', 'батаре',
      'battery', 'accumulator', 'akkumulyator', 'akumulyator', 'akb',
    ],
  },
  // Filters → Maintenance & Fluids
  {
    main: PartMainCategory.FILTERS,
    vehicle: PartVehicleCategory.MAINTENANCE_AND_FLUIDS,
    keywords: [
      'фильтр', 'фильтр масл', 'фильтр воздуш', 'фильтр салон', 'фильтр топлив',
      'filter', 'oil filter', 'air filter', 'cabin filter', 'fuel filter',
      'filtr', 'filtir', 'havo filtri', 'moy filtri', 'salon filtri',
    ],
  },
  // Ignition → Engine
  {
    main: PartMainCategory.IGNITION,
    vehicle: PartVehicleCategory.ENGINE,
    keywords: [
      'свеч', 'свеча', 'катушк', 'катушка зажиг', 'зажиган', 'провода высоков',
      'spark plug', 'spark', 'ignition coil', 'ignition', 'glow plug',
      'svecha', 'shamlar', 'sham', 'katushka', 'alanga',
    ],
  },
  // Engine → Engine
  {
    main: PartMainCategory.ENGINE,
    vehicle: PartVehicleCategory.ENGINE,
    keywords: [
      'двигател', 'мотор', 'поршень', 'клапан', 'коленвал', 'распредвал', 'прокладк',
      'грм', 'цепь грм', 'помпа', 'турбин', 'форсунк', 'блок цилиндр', 'гбц',
      'engine', 'motor', 'piston', 'valve', 'crankshaft', 'camshaft', 'gasket',
      'timing belt', 'water pump', 'turbo', 'injector', 'cylinder head',
      'dvigatel', 'motori', 'porshen', 'klapan', 'forsunka', 'nasos',
    ],
  },
  // Electrical Parts → Electrical & Lighting
  {
    main: PartMainCategory.ELECTRICAL_PARTS,
    vehicle: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
    keywords: [
      'генератор', 'стартер', 'реле', 'датчик', 'проводк', 'предохранит', 'блок управлен',
      'эбу', 'клемм', 'электрик', 'электрич',
      'generator', 'alternator', 'starter', 'relay', 'sensor', 'wiring', 'fuse', 'ecu',
      'generator', 'starter', 'datchik', 'rele', 'elektr', 'blok upravleniya',
    ],
  },
  // Oil & Fluids → Maintenance & Fluids
  {
    main: PartMainCategory.OIL_AND_FLUIDS,
    vehicle: PartVehicleCategory.MAINTENANCE_AND_FLUIDS,
    keywords: [
      // Compound forms first so "моторное масло" (motor oil) classifies as Oil,
      // not Engine — the bare "мотор" stem lives under the Engine rule.
      'моторное масло', 'масло моторное', 'motor oil', 'motor moyi',
      'масло', 'антифриз', 'тосол', 'жидкост', 'тормозная жидкост', 'омывател', 'смазк',
      'oil', 'antifreeze', 'coolant', 'fluid', 'brake fluid', 'grease', 'lubricant',
      'moy', 'moyi', 'antifriz', 'suyuqlik', 'tormoz suyuqligi',
    ],
  },
  // Belts & Hoses → Engine
  {
    main: PartMainCategory.BELTS_AND_HOSES,
    vehicle: PartVehicleCategory.ENGINE,
    keywords: [
      'ремень', 'ремен', 'ролик', 'патрубок', 'шланг', 'приводной ремень',
      'belt', 'hose', 'drive belt', 'timing belt', 'pulley', 'tensioner',
      'remen', 'kamar', 'shlang', 'patrubok', 'rolik',
    ],
  },
  // Wipers → Exterior
  {
    main: PartMainCategory.WIPERS,
    vehicle: PartVehicleCategory.TUNING_AND_ACCESSORIES,
    keywords: [
      'дворник', 'щетк', 'стеклоочистител', 'щётк',
      'wiper', 'wiper blade', 'windshield wiper',
      'tozalagich', 'dvornik', 'shetka', 'oyna tozalagich',
    ],
  },
  // Lighting → Electrical & Lighting
  {
    main: PartMainCategory.LIGHTING,
    vehicle: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
    keywords: [
      'фар', 'фара', 'лампа', 'ксенон', 'led', 'фонар', 'подсветк', 'габарит', 'птф',
      'headlight', 'light', 'lamp', 'bulb', 'xenon', 'led', 'tail light', 'fog light',
      'far', 'chiroq', 'lampa', 'yorug', 'fonar',
    ],
  },
  // Suspension → Suspension & Steering
  {
    main: PartMainCategory.SUSPENSION,
    vehicle: PartVehicleCategory.SUSPENSION_AND_STEERING,
    keywords: [
      'амортизатор', 'подвеск', 'рычаг', 'шаровая', 'стойк', 'пружин', 'сайлентблок',
      'рулев', 'рейка', 'наконечник', 'ступиц', 'шрус', 'стабилизатор',
      'shock absorber', 'suspension', 'strut', 'spring', 'control arm', 'ball joint',
      'steering', 'tie rod', 'wheel hub', 'cv joint', 'stabilizer',
      'amortizator', 'podveska', 'richag', 'sharovaya', 'rulevoy', 'stoyka',
    ],
  },
  // Exterior → Tuning & Accessories
  {
    main: PartMainCategory.EXTERIOR,
    vehicle: PartVehicleCategory.TUNING_AND_ACCESSORIES,
    keywords: [
      'бампер', 'капот', 'крыл', 'дверь', 'зеркал', 'решетк', 'молдинг', 'спойлер',
      'обвес', 'порог', 'багажник крышк', 'кузов',
      'bumper', 'hood', 'fender', 'door', 'mirror', 'grille', 'molding', 'spoiler',
      'body kit', 'trunk lid', 'body',
      'bamper', 'kapot', 'eshik', 'oyna', 'panjara', 'qanot',
    ],
  },
  // Transmission → Transmission (no dedicated MAIN bucket; maps to Engine main)
  {
    main: PartMainCategory.ENGINE,
    vehicle: PartVehicleCategory.TRANSMISSION,
    keywords: [
      'коробка передач', 'кпп', 'акпп', 'мкпп', 'сцеплен', 'трансмисс', 'вариатор',
      'маховик', 'коробк', 'дифференциал', 'привод',
      'transmission', 'gearbox', 'clutch', 'cvt', 'flywheel', 'differential', 'axle',
      'korobka', 'kpp', 'stseplenie', 'transmissiya', 'mufta',
    ],
  },
  // Heating & Cooling → Heating & Cooling (maps to Engine main bucket)
  {
    main: PartMainCategory.ENGINE,
    vehicle: PartVehicleCategory.HEATING_AND_COOLING,
    keywords: [
      'радиатор', 'кондиционер', 'печк', 'вентилятор', 'термостат', 'компрессор кондиц',
      'испарител', 'отоплен', 'охлажден',
      'radiator', 'air conditioner', 'heater', 'fan', 'thermostat', 'ac compressor',
      'evaporator', 'cooling', 'condenser',
      'radiator', 'konditsioner', 'pechka', 'ventilyator', 'termostat', 'sovutish',
    ],
  },
];

/** Normalize text for matching: lowercase, collapse whitespace. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Score every category rule against the text and return the best (main, vehicle)
 * pair. Longer keyword matches weigh more (a specific term like "тормозной диск"
 * beats a generic "диск"); count of distinct hits adds to the score so a listing
 * that mentions several terms of one category is classified confidently.
 * Returns null when nothing matched (caller applies the fallback).
 */
function classifyCategory(
  text: string,
): { main: PartMainCategory; vehicle: PartVehicleCategory } | null {
  let best: CategoryRule | null = null;
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (text.includes(kw)) score += kw.length; // longer/more-specific ⇒ higher
    }
    if (score > bestScore) {
      bestScore = score;
      best = rule;
    }
  }

  return best ? { main: best.main, vehicle: best.vehicle } : null;
}

/** Detect region of origin: explicit keyword first, else the make's home market. */
function classifyRegion(text: string, make: string | null): PartOriginRegion | null {
  let best: PartOriginRegion | null = null;
  let bestScore = 0;
  for (const [region, keywords] of Object.entries(REGION_KEYWORDS) as [PartOriginRegion, string[]][]) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score += kw.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = region;
    }
  }
  if (best) return best;
  // No explicit origin keyword → fall back to the detected make's home market.
  return make ? (MAKE_REGION[make] ?? null) : null;
}

/**
 * Classify a listing's title + description into the stored catalog attributes.
 * Always returns a main + vehicle category (fallback when nothing scores), so
 * the value is never empty; region/GM/OEM are populated when inferable.
 */
export function classifyPart(
  title: string | null | undefined,
  description: string | null | undefined,
): PartClassification {
  const combined = normalize([title ?? '', description ?? ''].join(' '));

  const category = classifyCategory(combined);
  const main = category?.main ?? FALLBACK_MAIN;
  const vehicle = category?.vehicle ?? FALLBACK_VEHICLE;

  // Make (and thus GM/region defaults) from the shared vehicle catalog.
  const make = matchCatalog(combined).brand;
  const isGm = make ? GM_MAKES.has(make) : false;
  const originRegion = classifyRegion(combined, make);
  const isOem = OEM_KEYWORDS.some((kw) => combined.includes(kw));

  return { mainCategory: main, vehicleCategory: vehicle, originRegion, isOem, isGm, make };
}
