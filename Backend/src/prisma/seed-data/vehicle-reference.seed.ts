/**
 * G-2 vehicle reference dataset: what the Garage make/model picker is missing.
 *
 * This is the frozen output of the Phase 1 source audit (2026-09-25), which read
 * all 1254 production parts, the live Reference API, the seller bot's catalogue
 * (`src/telegram/wizard-catalog.ts`) and the Drivers Village dealer mapper. It is
 * NOT derived from the mobile app's bundled catalogue.
 *
 * Only pairs that real production parts already fit are added, plus Chevrolet
 * Cruze by explicit decision. Everything here is ADDITIVE: the seed creates rows
 * that are missing and never renames, reorders, deletes or re-keys a row that
 * exists (see `src/prisma/vehicle-reference-seed.ts`).
 *
 * Names matter more than ids. Garage fitment compares the reference make/model
 * NAME with the names sellers and the dealer import store on parts
 * (case-insensitively, `parts.service.ts`), so every name below is copied
 * verbatim from the seller bot or the dealer mapper, and a test holds it there.
 *
 * Ids follow the rule the admin console uses (a slug of the name), except where
 * the slug is already taken: model ids are one GLOBAL key space, not per make.
 */

export interface SeedReferenceMake {
  /** Stable id; created only if missing, never changed. */
  id: string;
  /** Exact seller-bot / dealer make name. */
  name: string;
  /** Where the make is used today (audit, 2026-09-25). */
  evidence: string;
}

export interface SeedReferenceModel {
  /** Stable, globally unique id; created only if missing, never changed. */
  id: string;
  makeId: string;
  /** Exact seller-bot / dealer model name. */
  name: string;
  /** Where the pair is used today (audit, 2026-09-25). */
  evidence: string;
}

/** A deliberate visibility change for ONE named make; never a generic rule. */
export interface SeedMakeStateChange {
  makeId: string;
  isActive: boolean;
  /** Refuse the change if the make has gained models since the audit. */
  requireNoModels: boolean;
  reason: string;
}

/**
 * Makes absent from the reference today (Reference API → 404). They are created
 * active and not "coming soon", because each one ships with models that
 * production parts already fit.
 */
export const REFERENCE_NEW_MAKES: SeedReferenceMake[] = [
  {
    id: 'ravon',
    name: 'Ravon',
    evidence: 'seller bot; 4 production parts fit R4 (Cobalt)',
  },
  {
    id: 'ssangyong',
    name: 'SsangYong',
    evidence: 'dealer import; 11 production parts fit a model, 10 fit the make',
  },
  {
    id: 'skoda',
    name: 'Skoda',
    evidence: 'seller bot; 2 production parts fit Kodiaq, 17 fit the make',
  },
  {
    id: 'genesis',
    name: 'Genesis',
    evidence: 'dealer import; 2 production parts fit G90',
  },
];

/**
 * Missing model pairs, most-used first within each make. New rows are appended
 * after the make's existing models, so the current picker order is unchanged.
 */
export const REFERENCE_NEW_MODELS: SeedReferenceModel[] = [
  // Chevrolet. `matiz` is Daewoo's model id, so Chevrolet's Matiz takes a
  // make-prefixed id (G-2 decision 3).
  {
    id: 'chevrolet-matiz',
    makeId: 'chevrolet',
    name: 'Matiz',
    evidence: 'seller bot; 55 production parts',
  },
  {
    id: 'equinox',
    makeId: 'chevrolet',
    name: 'Equinox',
    evidence: 'seller bot; 26 production parts',
  },
  {
    id: 'traverse',
    makeId: 'chevrolet',
    name: 'Traverse',
    evidence: 'seller bot; 24 production parts',
  },
  {
    id: 'tahoe',
    makeId: 'chevrolet',
    name: 'Tahoe',
    evidence: 'seller bot; 17 production parts',
  },
  {
    id: 'trailblazer',
    makeId: 'chevrolet',
    name: 'Trailblazer',
    evidence: 'seller bot; 16 production parts',
  },
  {
    id: 'epica',
    makeId: 'chevrolet',
    name: 'Epica',
    evidence: 'dealer import (EPICA); 9 production parts',
  },
  {
    id: 'labo',
    makeId: 'chevrolet',
    name: 'Labo',
    evidence: 'seller bot; 4 production parts',
  },
  {
    id: 'nexia-1',
    makeId: 'chevrolet',
    name: 'Nexia 1',
    evidence:
      'dealer import (NEXIA-1); 2 production parts. The seller bot lists Nexia 1 under Daewoo',
  },
  {
    id: 'tacuma',
    makeId: 'chevrolet',
    name: 'Tacuma',
    evidence: 'dealer import (TACUMA); 1 production part',
  },
  {
    id: 'cruze',
    makeId: 'chevrolet',
    name: 'Cruze',
    evidence: 'seller bot; 0 production parts, added by explicit G-2 decision',
  },

  {
    id: 'r4-cobalt',
    makeId: 'ravon',
    name: 'R4 (Cobalt)',
    evidence: 'seller bot; 4 production parts',
  },

  {
    id: 'torres',
    makeId: 'ssangyong',
    name: 'Torres',
    evidence: 'dealer import (TORRES); 4 production parts',
  },
  {
    id: 'rexton',
    makeId: 'ssangyong',
    name: 'Rexton',
    evidence: 'dealer import (REXTON); 4 production parts',
  },
  {
    id: 'korando',
    makeId: 'ssangyong',
    name: 'Korando',
    evidence: 'dealer import (KORANDO); 2 production parts',
  },
  {
    id: 'musso',
    makeId: 'ssangyong',
    name: 'Musso',
    evidence: 'dealer import (MUSSO); 1 production part',
  },

  {
    id: 'kodiaq',
    makeId: 'skoda',
    name: 'Kodiaq',
    evidence: 'seller bot; 2 production parts',
  },

  {
    id: 'g90',
    makeId: 'genesis',
    name: 'G90',
    evidence: 'dealer import (G90); 2 production parts',
  },
];

export const REFERENCE_MAKE_STATE_CHANGES: SeedMakeStateChange[] = [
  {
    makeId: 'leapmotor',
    isActive: false,
    requireNoModels: true,
    reason:
      'active with 0 models and no confirmed Mator/UZ-market model data (G-2 decision 4)',
  },
];

/**
 * Existing-data problems this seed deliberately leaves alone. Each needs its own
 * migration or a product decision; they are printed on every run so they stay
 * visible.
 */
export const REFERENCE_KNOWN_ISSUES: string[] = [
  'chevrolet: `tracker` and `tracker-2` are both named "Tracker". Both ids stay, and so does the name, because seller-bot fitment matches "Tracker" (G-2 decision 1).',
  'chevrolet: `genrta-lacetti` "Genrta" is a legacy admin row that garage vehicles reference. It needs its own cleanup migration and is not merged with `gentra` (G-2 decision 2).',
  'Nexia 1: the dealer import files it under Chevrolet and the seller bot under Daewoo. Only Chevrolet `nexia-1` is added; a Daewoo row would need its own id.',
  'Matiz: Daewoo `matiz` (inactive make) and Chevrolet `chevrolet-matiz` are separate rows. Ravon "Matiz" has no production parts and is not added.',
  'Model ids are one global key space, but the admin console only checks uniqueness within a make, so adding a model whose slug another make owns fails with 409.',
];
