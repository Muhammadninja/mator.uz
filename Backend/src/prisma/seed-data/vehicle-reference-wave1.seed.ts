import type {
  HeldCandidate,
  SeedReferenceModel,
  SourceRef,
} from './vehicle-reference.seed';

/**
 * Wave 1 vehicle reference dataset: Chevrolet, BYD and Volkswagen models that
 * are officially offered in Uzbekistan and missing from the reference.
 *
 * Owner decisions (2026-11-12) this file follows:
 *  • Create-only. No make is created, activated or deactivated (the policy in
 *    `vehicle-reference-datasets.ts` refuses both).
 *  • Every model carries an official manufacturer/distributor page showing it
 *    is offered in Uzbekistan. Years and body types are set only when such a
 *    page states them, and only on the NEW row; existing rows are never
 *    written, so no existing image identity can change.
 *  • A model year shown on a car for sale ("… 2026") is NOT a production
 *    range and is never used as one.
 *  • No generation entity. Facelifts and trims of a model already in the
 *    reference (Cobalt MCM, Tahoe High Country…) are covered by that model.
 *
 * Sources were read on 2026-11-12. The official BYD Uzbekistan site (byd.uz)
 * is a "coming soon" placeholder, so no BYD model is added: the only official
 * BYD Uzbekistan page names the three models the reference already has.
 */

const ACCESSED = '2026-11-12';

const CHEVROLET_UZ_CATALOGUE: SourceRef = {
  url: 'https://chevrolet.uz/ru/',
  publisher: 'UzAuto Motors (chevrolet.uz, the official Chevrolet catalogue)',
  accessedOn: ACCESSED,
  quote:
    'Catalogue tabs "SUV", "CARS-SEDAN", "LCV": SUV lists TRACKER, CAPTIVA, CHEVROLET EQUINOX PHEV ACTIV, TRAVERSE Z71, TAHOE HIGH COUNTRY, SUBURBAN HIGH COUNTRY; CARS-SEDAN lists ONIX, COBALT MCM; LCV lists LABO, DAMAS, DAMAS MOVE & MAX',
};

const VOLKSWAGEN_UZ_MODELS: SourceRef = {
  url: 'https://volkswagen.uz/ru/models.html',
  publisher:
    'Alyans Auto, "официальный представитель Volkswagen в Узбекистане" (volkswagen.uz)',
  accessedOn: ACCESSED,
  quote:
    '"6 Models": Lavida XR, Passat Pro, Teramont Pro, Teramont X, TharuXR, Tiguan L Pro',
};

const VOLKSWAGEN_NEWSROOM_UZ: SourceRef = {
  url: 'https://www.volkswagen-newsroom.com/en/press-releases/tapping-into-a-growth-market-volkswagen-models-now-also-available-in-uzbekistan-20482',
  publisher: 'Volkswagen AG (Volkswagen Newsroom), 2026-06-22',
  accessedOn: ACCESSED,
  quote:
    'At the launch, the model lineup included select vehicles from Volkswagen Passenger Cars such as the Tiguan L Pro, Passat Pro and Teramont Pro, in addition to models from the Jetta brand.',
};

const BYD_UZ_PREMIERE: SourceRef = {
  url: 'https://www.byd.com/us/news-list/BYD-New-Energy-Passenger-Cars-Premiere-in-Uzbekistan',
  publisher: 'BYD Company Ltd. (byd.com), 2023-03-17',
  accessedOn: ACCESSED,
  quote:
    'The product portfolio includes the BYD CHAZOR, the BYD SONG PLUS DM-i and the BYD HAN.',
};

export const WAVE1_MODELS: SeedReferenceModel[] = [
  {
    id: 'suburban',
    makeId: 'chevrolet',
    name: 'Suburban',
    evidence:
      'official UzAuto Motors catalogue lists SUBURBAN HIGH COUNTRY (High Country is the trim, as with the existing Tahoe row)',
    availability: [
      CHEVROLET_UZ_CATALOGUE,
      {
        url: 'https://chevrolet.uz/ru/2026/suburban',
        publisher: 'UzAuto Motors (chevrolet.uz)',
        accessedOn: ACCESSED,
        quote: 'SUBURBAN HIGH COUNTRY 2026',
      },
    ],
    bodyType: {
      // Production holds 'suv' (applied before the spelling decision); the seed
      // never rewrites an existing row, so that one row is fixed by hand.
      value: 'SUV',
      source: {
        ...CHEVROLET_UZ_CATALOGUE,
        quote: 'SUBURBAN HIGH COUNTRY is listed under the catalogue tab "SUV"',
      },
    },
    // No yearFrom/yearTo: "2026" on the page is the model year of the car on
    // sale, not a production range.
  },
];

/**
 * Considered and NOT added. Each needs an owner decision (would it be its own
 * model, or is it an existing one?) or an official source first. Adding a
 * variant as its own model would split name-based Garage fitment: a "Damas
 * Max" owner would stop seeing parts listed for "Damas".
 */
export const WAVE1_HELD: HeldCandidate[] = [
  {
    makeId: 'chevrolet',
    name: 'Equinox PHEV Activ',
    reason:
      'decision: a powertrain/trim variant of the existing `equinox`, or its own model?',
    sources: [CHEVROLET_UZ_CATALOGUE],
  },
  {
    makeId: 'chevrolet',
    name: 'Damas Move & Max',
    reason:
      'decision: variants of the existing `damas` (one catalogue card), or one or two models of their own (Damas Max cargo, Damas Move passenger)?',
    sources: [
      CHEVROLET_UZ_CATALOGUE,
      {
        url: 'https://chevrolet.uz/ru/damas-max-move',
        publisher: 'UzAuto Motors (chevrolet.uz)',
        accessedOn: ACCESSED,
        quote: 'DAMAS MOVE & MAX',
      },
    ],
  },
  {
    makeId: 'volkswagen',
    name: 'Passat Pro',
    reason:
      'decision: the same car as the existing `passat` "Passat", or its own model? Not added, so existing Passat fitment is not split',
    sources: [VOLKSWAGEN_UZ_MODELS, VOLKSWAGEN_NEWSROOM_UZ],
  },
  {
    makeId: 'volkswagen',
    name: 'Tiguan L Pro',
    reason:
      'decision: the same car as the existing `tiguan` "Tiguan", or its own model?',
    sources: [VOLKSWAGEN_UZ_MODELS, VOLKSWAGEN_NEWSROOM_UZ],
  },
  {
    makeId: 'volkswagen',
    name: 'Teramont Pro',
    reason:
      'decision: the same car as the existing `teramont` "Teramont", or its own model?',
    sources: [VOLKSWAGEN_UZ_MODELS, VOLKSWAGEN_NEWSROOM_UZ],
  },
  {
    makeId: 'volkswagen',
    name: 'Teramont X',
    reason:
      'decision: its own model, or a body variant of the existing `teramont`?',
    sources: [VOLKSWAGEN_UZ_MODELS],
  },
  {
    makeId: 'jetta',
    name: '(Jetta brand models)',
    reason:
      'no official model list: the newsroom names "models from the Jetta brand" without models, jetta.uz does not resolve. A Jetta make would also need a decision next to the existing Volkswagen `jetta` model',
    sources: [VOLKSWAGEN_NEWSROOM_UZ],
  },
  {
    makeId: 'byd',
    name: '(any model beyond Chazor, Song Plus, Han)',
    reason:
      'no official Uzbekistan lineup: byd.uz and www.byd.uz are "Сайт скоро запустится" placeholders. Yuan Up and Ti 7 appear only in press reports, which are not official sources',
    sources: [BYD_UZ_PREMIERE],
  },
];

export const WAVE1_KNOWN_ISSUES: string[] = [
  'Already covered by an existing row, so not added: Cobalt MCM (`cobalt`), Traverse Z71 (`traverse`), Tahoe High Country (`tahoe`), Lavida XR and Tharu XR (`lavida-xr`, `tharu-xr`).',
  'The official pages state body types for existing rows too (BYD Chazor "compact sedan", Song Plus "compact SUV", Han "sedan"; chevrolet.uz SUV/sedan tabs). They are NOT written: existing rows keep their body type, so no image identity changes.',
  'byd is "coming soon": a model added to it would stay non-tappable in the picker until the make is opened, which needs a separate approval.',
];
