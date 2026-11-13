import type {
  HeldCandidate,
  SeedReferenceModel,
  SourceRef,
} from './vehicle-reference.seed';

/**
 * Wave 2 vehicle reference dataset: inventory-driven.
 *
 * Input: the production read-only report of 2026-11-13 (sections 8 and 10:
 * the make/model names dealer inventory is listed under, with part counts and
 * Garage status) and the production snapshot captured 2026-11-13T09:42:21Z.
 * Only names that dealer inventory uses AND that no reference row matches are
 * candidates; a candidate is imported only with an official Uzbekistan source.
 *
 * Inventory names with no reference row (parts per name, per-model fitment):
 *   SsangYong Tivoli 8 · Hyundai Santa Fe 1 · Lada Largus 1
 * Every other inventory name already matches an existing row by exact name, so
 * no alias and no new row is needed for it (see WAVE2_KNOWN_ISSUES).
 *
 * Same rules as Wave 1: create-only, no make created or (de)activated, facts on
 * the new row only, each with its own official source. Sources read 2026-11-13.
 */

const ACCESSED = '2026-11-13';

const HYUNDAI_UZ_MODELS: SourceRef = {
  url: 'https://hyundai.uz/models/',
  publisher:
    'Hyundai Uzbekistan, "O‘zbekistondagi Hyundai rasmiy distribyutori" (hyundai.uz)',
  accessedOn: ACCESSED,
  quote:
    '"Barchasi (6)": Yengil avtomobillar: Elantra, Sonata; Krossoverlar: Mufasa, Santa Fe, Tucson; Minivenlar: Staria',
};

export const WAVE2_MODELS: SeedReferenceModel[] = [
  {
    // Hyundai's existing rows are make-prefixed (hyundai-sonata, hyundai-tucson…).
    id: 'hyundai-santa-fe',
    makeId: 'hyundai',
    name: 'Santa Fe',
    evidence:
      'dealer inventory: 1 part listed for Hyundai "Santa Fe" (report 2026-11-13, sections 8 and 10); official Hyundai Uzbekistan distributor lists Santa Fe. Make is inactive, so the row stays hidden until Hyundai is opened',
    availability: [
      HYUNDAI_UZ_MODELS,
      {
        url: 'https://hyundai.uz/models/santa-fe/',
        publisher: 'Hyundai Uzbekistan (hyundai.uz)',
        accessedOn: ACCESSED,
        quote:
          'Hyundai SANTA FE: Exclusive G0U5 2.5 GDI 8AT 4WD 7 o‘rinli; Calligraphy G0U6/G0U7 2.5T GDI 8DCT 4WD 6 o‘rinli',
      },
    ],
    bodyType: {
      // The vocabulary files a crossover as `SUV` (vehicle-body-types.ts).
      value: 'SUV',
      source: {
        ...HYUNDAI_UZ_MODELS,
        quote: 'Santa Fe is listed under "Krossoverlar" (crossovers)',
      },
    },
    // No years: neither page states a production range.
  },
];

/** Inventory names NOT imported: no official Uzbekistan source could be read. */
export const WAVE2_HELD: HeldCandidate[] = [
  {
    makeId: 'ssangyong',
    name: 'Tivoli',
    reason:
      'dealer inventory: 8 parts. No official Uzbekistan source: kgm.uz and ssangyong.uz serve a parked/mismatched TLS certificate, www.kgm.uz does not resolve, kg-mobility.com is a title-only page. Needs an official KGM/SsangYong Uzbekistan page',
    sources: [
      {
        url: 'https://www.kg-mobility.com/',
        publisher: 'KG Mobility (kg-mobility.com)',
        accessedOn: ACCESSED,
        quote:
          'KGM - Enjoy with Confidence I KGM 공식 사이트 (no model or dealer content)',
      },
    ],
  },
  {
    makeId: 'lada',
    name: 'Largus',
    reason:
      'dealer inventory: 1 part. No official Uzbekistan source: lada.uz refuses connections, and lada.ru lists Largus for the Russian market only, with Russian dealers. Needs an official Lada Uzbekistan page',
    sources: [
      {
        url: 'https://www.lada.ru/en',
        publisher: 'JSC AVTOVAZ (lada.ru)',
        accessedOn: ACCESSED,
        quote:
          'Granta, Vesta, Aura, Largus, Niva Travel, Niva Legend, Iskra, SKM (Russian market; no Uzbekistan dealer)',
      },
    ],
  },
];

export const WAVE2_KNOWN_ISSUES: string[] = [
  'BLOCKER (fitment, not changed here): Nexia 2 (238 parts), Nexia 3 (167) and Nexia 1 (9) are filed under the names of rows that are now hidden generation rows (variant_of_model_id = nexia). Garage fitment matches legacy rows on the vehicle model NAME (vehicle-fitment.ts) and never reads the generation pick, so an owner who picks the generic "Nexia" does not see these parts. Needs a fitment decision; no catalog row can fix it.',
  'Inventory under existing rows of INACTIVE makes (not changed: activation needs owner approval): SsangYong Rexton 42, Torres 34, Musso 15; Skoda Kodiaq 6; Daewoo Tico 2; Lada make-wide 1.',
  'Every other inventory name matches an existing selectable row by exact name; no alias is needed. "Tracker" (204 parts) matches both `tracker` and `tracker-2` (known duplicate, unchanged).',
  'The Wave 1 held candidates (Equinox PHEV Activ, Damas Move & Max, Passat Pro, Tiguan L Pro, Teramont Pro, Teramont X, Jetta brand, more BYD) have NO dealer inventory under those names, so they stay held.',
  'Body type spelling (owner decision 2026-11-13): new rows use the admin console\'s title case ("SUV", "Sedan", "Panel Van"). `suburban` was written as "suv" by Wave 1 before the decision and is NOT rewritten by the seed; fix that one row by hand.',
];
