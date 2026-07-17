// src/telegram/wizard-catalog.ts
//
// SINGLE SOURCE OF TRUTH for the brands and models the wizard offers. The exact
// brand/model buttons the bot displays, in display order. These canonical names
// are persisted verbatim into brands / car_models rows, so this file — not the
// parser catalog — is authoritative for what a wizard listing's vehicle is.
//
// The parser's VEHICLE_CATALOG (src/ai/vehicle-catalog.ts) is a SUPERSET that
// adds cyrillic aliases / typos for free-text matching and brands the wizard
// doesn't show. To prevent the two from drifting, `assertWizardCatalogInCanon`
// below runs AT MODULE LOAD and throws if any wizard (brand, model) is missing
// from the canon with the same spelling — so a mismatch fails fast at boot in
// every environment, not only when the accompanying spec runs. Adding a wizard
// model therefore forces you to add the same canonical name (plus its aliases)
// to VEHICLE_CATALOG, or the app won't start.

import { PartVehicleCategory } from '@prisma/client';
import { VEHICLE_CATALOG } from '../ai/vehicle-catalog';

export interface WizardBrand {
  /** Canonical brand name — authoritative; mirrored in VEHICLE_CATALOG canon. */
  name: string;
  /** Canonical model names in display order — authoritative; mirrored in canon. */
  models: string[];
}

export const WIZARD_BRANDS: WizardBrand[] = [
  {
    name: 'Chevrolet',
    models: [
      'Cobalt',
      'Gentra',
      'Spark',
      'Nexia 2',
      'Nexia 3',
      'Damas',
      'Labo',
      'Lacetti',
      'Matiz',
      'Captiva',
      'Tracker',
      'Equinox',
      'Malibu',
      'Cruze',
      'Orlando',
      'Onix',
      'Traverse',
      'Tahoe',
      'Trailblazer',
    ],
  },
  {
    name: 'Daewoo',
    models: ['Nexia 1', 'Nexia 2', 'Gentra', 'Matiz', 'Damas', 'Tico'],
  },
  {
    name: 'Ravon',
    models: ['R2 (Spark)', 'R3 (Nexia)', 'R4 (Cobalt)', 'Gentra', 'Matiz'],
  },
  {
    name: 'BYD',
    models: [
      'Chazor',
      'Song Plus',
      'Song Pro',
      'Song L',
      'Seagull',
      'Dolphin',
      'Seal',
      'Han',
      'Qin Plus',
      'Yuan Up',
      'Yuan Plus',
      'Tang',
      'Destroyer 05',
      'Sealion 07',
      'Leopard 5',
    ],
  },
  {
    name: 'Kia',
    models: [
      'K3',
      'K4',
      'K5',
      'K7',
      'K8',
      'K9',
      'Cerato',
      'Seltos',
      'Sportage',
      'Sorento',
      'Mohave',
      'Telluride',
      'Carnival',
      'EV5',
      'EV6',
      'EV9',
      'Soul',
      'Sonet',
      'Optima',
      'Rio',
    ],
  },
  {
    name: 'Chery',
    models: [
      'Arrizo 5',
      'Arrizo 6',
      'Arrizo 8',
      'Tiggo 2',
      'Tiggo 4',
      'Tiggo 9',
      'Tiggo 7 Pro',
      'Tiggo 8 Pro',
    ],
  },
  {
    name: 'Hyundai',
    models: [
      'Elantra',
      'Sonata',
      'Accent',
      'Azera',
      'Tucson',
      'Santa Fe',
      'Palisade',
      'Creta',
      'Staria',
      'H-1',
      'Ioniq 5',
      'Ioniq 6',
      'Solaris',
    ],
  },
  {
    name: 'Lada',
    models: ['2106', '2107', '21099', 'Priora', 'Granta', 'Vesta'],
  },
  {
    name: 'Toyota',
    models: [
      'Corolla Cross',
      'Corolla',
      'Camry',
      'RAV4',
      'Highlander',
      'Land Cruiser Prado',
      'Land Cruiser 200',
      'Land Cruiser 300',
      'Land Cruiser',
      'Prado',
    ],
  },
  {
    name: 'Haval',
    models: ['H6', 'H9', 'Jolion', 'Dargo', 'M6'],
  },
  {
    name: 'Nissan',
    models: [
      'Sunny',
      'Sentra',
      'Sylphy',
      'Teana',
      'Altima',
      'Maxima',
      'Juke',
      'Qashqai',
      'X-Trail',
      'Murano',
      'Pathfinder',
      'Patrol',
      'Leaf',
      'Ariya',
      'Navara',
    ],
  },
  {
    name: 'Skoda',
    models: [
      'Fabia',
      'Rapid',
      'Octavia',
      'Superb',
      'Kamiq',
      'Karoq',
      'Kodiaq',
      'Enyaq',
    ],
  },
  {
    name: 'Volkswagen',
    models: [
      'Polo',
      'Jetta',
      'Passat',
      'Arteon',
      'Golf',
      'e-Bora',
      'Caddy',
      'Tiguan',
      'Teramont',
      'Touareg',
      'T-Roc',
      'ID.3',
      'ID.4',
      'ID.6',
      'ID.7',
    ],
  },
];

export interface WizardCategory {
  /** Stored enum value — the wizard writes this to Product.vehicleCategory. */
  value: PartVehicleCategory;
  /** Russian button label (the bot speaks Russian). */
  label: string;
}

// The 8 wizard categories are EXACTLY the buyer catalog's PartVehicleCategory
// values (see part-categories.catalog.ts), so a wizard-created product filters
// identically to any other. Labels are the Russian names from the requirements.
export const WIZARD_CATEGORIES: WizardCategory[] = [
  { value: PartVehicleCategory.BRAKE_SYSTEM, label: 'Тормозная система' },
  { value: PartVehicleCategory.MAINTENANCE_AND_FLUIDS, label: 'ТО и Жидкости' },
  {
    value: PartVehicleCategory.SUSPENSION_AND_STEERING,
    label: 'Ходовая и Рулевое',
  },
  {
    value: PartVehicleCategory.ELECTRICAL_AND_LIGHTING,
    label: 'Электрика и Оптика',
  },
  { value: PartVehicleCategory.ENGINE, label: 'Двигатель' },
  { value: PartVehicleCategory.TRANSMISSION, label: 'Трансмиссия' },
  {
    value: PartVehicleCategory.HEATING_AND_COOLING,
    label: 'Климат и Охлаждение',
  },
  {
    value: PartVehicleCategory.TUNING_AND_ACCESSORIES,
    label: 'Тюнинг и Стайлинг',
  },
];

/**
 * Verify every wizard (brand, model) pair exists with the SAME canonical
 * spelling in VEHICLE_CATALOG. Exported so the spec can assert the message; also
 * invoked once at module load below so drift crashes the app at boot rather than
 * silently persisting a brand/model the parser canon doesn't recognize. Returns
 * the list of offending "Brand Model" strings (empty when consistent).
 */
export function findWizardCatalogDrift(): string[] {
  const drift: string[] = [];
  for (const wizardBrand of WIZARD_BRANDS) {
    const canonBrand = VEHICLE_CATALOG.find(
      (b) => b.canonical === wizardBrand.name,
    );
    if (!canonBrand) {
      drift.push(`${wizardBrand.name} (brand missing from VEHICLE_CATALOG)`);
      continue;
    }
    const canonModels = new Set(canonBrand.models.map((m) => m.canonical));
    for (const model of wizardBrand.models) {
      if (!canonModels.has(model)) drift.push(`${wizardBrand.name} ${model}`);
    }
  }
  return drift;
}

/** Throw if the wizard catalog has drifted from the parser canon. */
export function assertWizardCatalogInCanon(): void {
  const drift = findWizardCatalogDrift();
  if (drift.length > 0) {
    throw new Error(
      'wizard-catalog drift: these wizard (brand, model) pairs are missing from ' +
        `VEHICLE_CATALOG with a matching canonical name: ${drift.join(', ')}. ` +
        'Add them (with aliases) to src/ai/vehicle-catalog.ts, or fix the spelling.',
    );
  }
}

// Fail fast at boot: a wizard model the parser canon doesn't know must never
// reach production (it would persist a car_models row disconnected from search).
assertWizardCatalogInCanon();
