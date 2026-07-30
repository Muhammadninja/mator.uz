/**
 * Fitment Studio — node seed + category validation.
 *
 * NODE_SEED: the 7 hotspots, with world-space coordinates that MUST match the
 * admin's three.js scene (fitment-stage.tsx NODES table) so the DB nodes line up
 * with the 3D model. Seed once (see seedFitmentNodes in src/prisma/seed.ts).
 *
 * NODE_ALLOWED_CATEGORIES: the category guard from the task — a part may only
 * bind to a node whose category accepts the part's catalogue category. Keys
 * are CatalogPart.category.slug values. Example enforced: an "oils" part cannot
 * bind to FRONT_BRAKES / REAR_BRAKES.
 */

import { NodeCategory } from '@prisma/client';

export const NODE_SEED: {
  category: NodeCategory;
  name: string;
  positionX: number;
  positionY: number;
  positionZ: number;
}[] = [
  { category: NodeCategory.ENGINE, name: 'Моторный отсек', positionX: 0.0, positionY: 0.62, positionZ: 1.35 },
  { category: NodeCategory.FRONT_BRAKES, name: 'Передние тормоза', positionX: 0.86, positionY: 0.34, positionZ: 1.3 },
  { category: NodeCategory.REAR_BRAKES, name: 'Задние тормоза', positionX: 0.86, positionY: 0.34, positionZ: -1.32 },
  { category: NodeCategory.SUSPENSION, name: 'Подвеска', positionX: -0.86, positionY: 0.36, positionZ: 1.28 },
  { category: NodeCategory.TRANSMISSION, name: 'Трансмиссия', positionX: 0.0, positionY: 0.34, positionZ: 0.45 },
  { category: NodeCategory.ELECTRICAL, name: 'Аккумулятор', positionX: -0.52, positionY: 0.68, positionZ: 1.12 },
  { category: NodeCategory.EXHAUST, name: 'Выпуск', positionX: 0.0, positionY: 0.22, positionZ: -1.95 },
];

/**
 * node category → catalogue category slugs allowed on it. Adjust the slugs to
 * match your Category taxonomy. If a part's category cannot be resolved to a
 * slug the guard is lenient (allows) — it only blocks KNOWN mismatches.
 */
export const NODE_ALLOWED_CATEGORIES: Record<NodeCategory, string[]> = {
  ENGINE: ['engine', 'filters', 'ignition', 'oils', 'fluids', 'cooling', 'belts', 'gaskets'],
  FRONT_BRAKES: ['brakes', 'brake-hydraulics'],
  REAR_BRAKES: ['brakes', 'brake-hydraulics'],
  SUSPENSION: ['suspension', 'steering'],
  TRANSMISSION: ['transmission', 'clutch', 'fluids'],
  ELECTRICAL: ['electrical', 'battery', 'ignition'],
  EXHAUST: ['exhaust', 'emissions', 'gaskets'],
};

/** Completion status shown per node in the studio. */
export type CompletionStatus = 'EMPTY' | 'PARTIAL' | 'COMPLETE';

/** EMPTY (0) · PARTIAL (1-3) · COMPLETE (>3 parts OR any bound part has an OEM). */
export function completionStatus(mappedCount: number, hasOem: boolean): CompletionStatus {
  if (mappedCount === 0) return 'EMPTY';
  if (mappedCount > 3 || hasOem) return 'COMPLETE';
  return 'PARTIAL';
}
