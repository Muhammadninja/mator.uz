/**
 * Fitment Studio — node seed + category mapping.
 *
 * NODE_SEED: the 7 hotspots. The `position*` columns are a leftover of the 3D
 * scene the admin deleted (mator-admin commit 6132393); nothing reads them any
 * more, but the rows themselves are still the FK target of every binding, so
 * the seed stays (see seedFitmentNodes in src/prisma/seed.ts).
 *
 * NODE_CATEGORY_SLUGS: node → the catalogue categories that legitimately mount
 * there. Slugs are the REAL PartCategory ids/slugs from the live taxonomy
 * (src/prisma/seed-data/subcategory-taxonomy.seed.ts) — roots like
 * `brake-system` and their children like `front-brake-pads`. An earlier version
 * of this file listed friendly names (`brakes`, `oils`, `filters`) that exist
 * nowhere in the database, which made the bind guard reject every real part.
 */

import { NodeCategory } from '@prisma/client';

export const NODE_SEED: {
  category: NodeCategory;
  name: string;
  positionX: number;
  positionY: number;
  positionZ: number;
}[] = [
  {
    category: NodeCategory.ENGINE,
    name: 'Моторный отсек',
    positionX: 0.0,
    positionY: 0.62,
    positionZ: 1.35,
  },
  {
    category: NodeCategory.FRONT_BRAKES,
    name: 'Передние тормоза',
    positionX: 0.86,
    positionY: 0.34,
    positionZ: 1.3,
  },
  {
    category: NodeCategory.REAR_BRAKES,
    name: 'Задние тормоза',
    positionX: 0.86,
    positionY: 0.34,
    positionZ: -1.32,
  },
  {
    category: NodeCategory.SUSPENSION,
    name: 'Подвеска',
    positionX: -0.86,
    positionY: 0.36,
    positionZ: 1.28,
  },
  {
    category: NodeCategory.TRANSMISSION,
    name: 'Трансмиссия',
    positionX: 0.0,
    positionY: 0.34,
    positionZ: 0.45,
  },
  {
    category: NodeCategory.ELECTRICAL,
    name: 'Аккумулятор',
    positionX: -0.52,
    positionY: 0.68,
    positionZ: 1.12,
  },
  {
    category: NodeCategory.EXHAUST,
    name: 'Выпуск',
    positionX: 0.0,
    positionY: 0.22,
    positionZ: -1.95,
  },
];

/**
 * node → allowed catalogue category slugs (a category's own slug OR its root's).
 *
 * Brake subcategories are split front/rear on purpose: `front-brake-pads` on
 * REAR_BRAKES is the one mis-bind an operator makes by muscle memory, and it is
 * the one this table can catch. Everything shared between the two axles
 * (discs, calipers, cylinders, hoses) is listed under both.
 *
 * There is no exhaust taxonomy yet, so EXHAUST accepts the engine tree — an
 * exhaust manifold gasket lives in `gaskets-and-seals` today.
 */
export const NODE_CATEGORY_SLUGS: Record<NodeCategory, string[]> = {
  ENGINE: [
    'engine-system',
    'timing-belt-kits',
    'accessory-drive-belts',
    'gaskets-and-seals',
    'piston-group',
    'valves-and-cylinder-head',
    'engine-mounts',
    // Cooling and the maintenance/fluids tree have no node of their own; they
    // are engine-bay work, so they mount here.
    'heating-and-cooling',
    'cooling-radiators',
    'heater-cores',
    'water-pumps',
    'thermostats',
    'coolant-hoses-tanks',
    'cooling-fans',
    'maintenance-and-fluids',
    'oil-filters',
    'air-filters',
    'cabin-filters',
    'fuel-filters',
    'antifreeze',
    'technical-fluids',
    'motor-oil',
    'synthetic-motor-oil',
    'semi-synthetic-motor-oil',
    'mineral-motor-oil',
  ],
  FRONT_BRAKES: [
    'brake-system',
    'front-brake-pads',
    'brake-discs',
    'brake-calipers-kits',
    'brake-cylinders',
    'brake-hoses-cables',
  ],
  REAR_BRAKES: [
    'brake-system',
    'rear-brake-pads',
    'brake-discs',
    'brake-calipers-kits',
    'brake-cylinders',
    'brake-hoses-cables',
  ],
  SUSPENSION: [
    'suspension-and-steering',
    'shock-absorbers',
    'springs-and-mounts',
    'stabilizer-links-bushings',
    'control-arms-bushings',
    'ball-joints',
    'steering-racks-tie-rods',
    'wheel-hubs-bearings',
  ],
  TRANSMISSION: [
    'transmission',
    'clutch-kits',
    'cv-joints-driveshafts',
    'cv-joint-boots',
    'flywheels',
    'gear-linkages-cables',
    'transmission-oil',
  ],
  ELECTRICAL: [
    'electrical-and-lighting',
    'spark-plugs',
    'ignition-coils-wires',
    'alternators',
    'starters',
    'engine-sensors',
    'headlights-and-bulbs',
  ],
  EXHAUST: ['engine-system', 'gaskets-and-seals'],
};

/** Back-compat alias: the car-first service imports this name. */
export const NODE_ALLOWED_CATEGORIES = NODE_CATEGORY_SLUGS;

/** Every slug some node claims. A slug outside this set is UNGOVERNED. */
const GOVERNED_SLUGS = new Set<string>(
  Object.values(NODE_CATEGORY_SLUGS).flat(),
);

/** slug → the node it most likely mounts to, for `suggestedNodeCategory`.
 *  First writer wins, so the specific brake subcategories claim their own axle
 *  while the shared ones resolve to FRONT_BRAKES (what an operator expects when
 *  a disc could be either). */
const NODE_BY_SLUG = new Map<string, NodeCategory>();
for (const node of [
  NodeCategory.FRONT_BRAKES,
  NodeCategory.REAR_BRAKES,
  NodeCategory.SUSPENSION,
  NodeCategory.TRANSMISSION,
  NodeCategory.ELECTRICAL,
  NodeCategory.EXHAUST,
  NodeCategory.ENGINE,
]) {
  for (const slug of NODE_CATEGORY_SLUGS[node]) {
    if (!NODE_BY_SLUG.has(slug)) NODE_BY_SLUG.set(slug, node);
  }
}
// `rear-brake-pads` is claimed by REAR_BRAKES above; the shared brake slugs and
// the `brake-system` root fall to FRONT_BRAKES, which is the right default for
// a part-first queue where the operator picks the axle anyway.

/**
 * The node to pre-select for a part, from its own category slug and (fallback)
 * its root's. `null` when neither is governed — the client then falls back to
 * its own slug table rather than pre-selecting a node the guard would reject.
 */
export function suggestedNodeFor(
  slug?: string | null,
  rootSlug?: string | null,
): NodeCategory | null {
  return (
    (slug ? NODE_BY_SLUG.get(slug) : undefined) ??
    (rootSlug ? NODE_BY_SLUG.get(rootSlug) : undefined) ??
    null
  );
}

/**
 * The bind guard. Blocks only KNOWN mismatches: a part whose category (or whose
 * root category) is claimed by some node, offered to a different node. A part
 * in an ungoverned category (tuning, accessories, uncategorized, anything
 * seeded after this table) is allowed anywhere — a data-entry tool that refuses
 * work it cannot classify is worse than one that trusts the operator.
 */
export function isCategoryAllowedOnNode(
  node: NodeCategory,
  slug?: string | null,
  rootSlug?: string | null,
): boolean {
  const governed =
    (slug && GOVERNED_SLUGS.has(slug)) ||
    (rootSlug && GOVERNED_SLUGS.has(rootSlug));
  if (!governed) return true;
  const allowed = NODE_CATEGORY_SLUGS[node];
  return (
    (!!slug && allowed.includes(slug)) ||
    (!!rootSlug && allowed.includes(rootSlug))
  );
}

/** Completion status shown per node in the studio. */
export type CompletionStatus = 'EMPTY' | 'PARTIAL' | 'COMPLETE';

/** EMPTY (0) · PARTIAL (1-3) · COMPLETE (>3 parts OR any bound part has an OEM). */
export function completionStatus(
  mappedCount: number,
  hasOem: boolean,
): CompletionStatus {
  if (mappedCount === 0) return 'EMPTY';
  if (mappedCount > 3 || hasOem) return 'COMPLETE';
  return 'PARTIAL';
}
