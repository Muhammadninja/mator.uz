/**
 * parse-schema.ts — Prisma schema → 3D Blueprint graph JSON.
 *
 * Reads `prisma/schema.prisma`, extracts every model, its scalar-field count,
 * and its foreign-key relations, then groups the models into logical modules
 * (Users/Auth, Catalog/Products, Commerce/Orders, Fitment/3D, …). The output is
 * a `{ modules, nodes, edges }` graph the frontend `DatabaseBlueprint3D`
 * component renders as a Sci-Fi blueprint.
 *
 * It is dependency-free on purpose (no `@prisma/internals` / DMMF): a focused
 * line parser is deterministic, fast, and doesn't pull the Prisma engine into a
 * build script. Prisma's grammar for what we need (model blocks, `Type` /
 * `Type?` / `Type[]` fields, `@relation(fields: [...])`) is regular enough to
 * parse reliably.
 *
 *   Run:  npx ts-node scripts/parse-schema.ts
 *   Out:  src/blueprint/db-graph.generated.json
 *
 * The backend also serves this JSON live at GET /blueprint/graph (see
 * blueprint.controller.ts); regenerating the file keeps that endpoint current.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Module taxonomy ───────────────────────────────────────────────────────────
// Each rule owns a colour and a predicate over the model name. Rules are tried
// top-to-bottom; the FIRST match wins, so order from most- to least-specific.
// A model matching no rule lands in the `Misc` group (and is logged, so the
// taxonomy can be kept complete as the schema grows).
interface ModuleRule {
  group: string;
  /** Neon accent used for this module's nodes + outgoing edges. */
  color: string;
  match: (model: string) => boolean;
}

const has = (...needles: string[]) => (m: string) =>
  needles.some((n) => m.toLowerCase().includes(n.toLowerCase()));

const MODULE_RULES: ModuleRule[] = [
  // Most specific first — Admin before generic "user", Fitment before Vehicle.
  { group: 'Admin/Ops', color: '#f472b6', match: has('Admin') },
  {
    group: 'Fitment/3D',
    color: '#22d3ee',
    match: has('VehicleNode', 'FitmentBinding', 'Vehicle3dAsset', 'TuningVariant'),
  },
  {
    group: 'Users/Auth',
    color: '#38bdf8',
    match: has(
      'AppUser',
      'AuthIdentity',
      'RefreshToken',
      'EmailVerification',
      'PhoneOtp',
      'MyId',
      'Device',
    ),
  },
  { group: 'Users/Auth', color: '#38bdf8', match: has('Address') },
  {
    group: 'Garage/Vehicles',
    color: '#a78bfa',
    match: has('Vehicle', 'CarModel', 'Brand'),
  },
  {
    group: 'Providers/Services',
    color: '#34d399',
    match: has('Provider', 'Booking'),
  },
  {
    group: 'Catalog/Parts',
    color: '#facc15',
    match: has('CatalogPart', 'CatalogSeller', 'PartCategory', 'PartBrand', 'PartCompatibility', 'PartModel', 'OemCompatibility'),
  },
  {
    group: 'Catalog/Products',
    color: '#fb923c',
    match: has('Product', 'Seller', 'Stock'),
  },
  {
    group: 'Commerce/Orders',
    color: '#f87171',
    match: has('Order', 'Cart', 'Payment', 'Sale'),
  },
  {
    group: 'Messaging/AI',
    color: '#c084fc',
    match: has('Notification', 'Ai', 'Sms'),
  },
];

const MISC = { group: 'Misc', color: '#94a3b8' };

function classify(model: string): { group: string; color: string } {
  for (const rule of MODULE_RULES) {
    if (rule.match(model)) return { group: rule.group, color: rule.color };
  }
  return MISC;
}

// ── Graph shape (kept in sync with mator-admin/src/lib/blueprint/types.ts) ─────
export interface GraphNode {
  id: string; // model name, e.g. "Order"
  table: string; // @@map name if present, else id
  group: string;
  color: string;
  fieldCount: number; // scalar + enum fields (excludes relation fields)
  relationCount: number; // outgoing FK relations
}

export interface GraphEdge {
  id: string; // `${source}->${target}:${field}`
  source: string; // FK-owning model
  target: string; // referenced model
  field: string; // relation field name on the source
}

export interface BlueprintGraph {
  generatedAt: string | null; // stamped by the caller; null keeps parse pure
  nodes: GraphNode[];
  edges: GraphEdge[];
  modules: { group: string; color: string; count: number }[];
}

// ── Parser ────────────────────────────────────────────────────────────────────
const MODEL_RE = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
const MAP_RE = /@@map\("([^"]+)"\)/;
// A field line: `name  Type...` where Type may carry ? or []. We capture name +
// bare type. Attributes/decorators are ignored beyond the @relation scan below.
const FIELD_RE = /^\s{2}(\w+)\s+(\w+)(\[\])?(\?)?/;
const RELATION_FIELDS_RE = /@relation\([^)]*fields:\s*\[([^\]]+)\]/;

export function parseSchema(schema: string): BlueprintGraph {
  // Pass 1: collect model names so we can tell relation fields (type is another
  // model) from scalar/enum fields (type is String/Int/an enum/etc.).
  const modelNames = new Set<string>();
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{/gm)) modelNames.add(m[1]);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const block of schema.matchAll(MODEL_RE)) {
    const name = block[1];
    const body = block[2];
    const { group, color } = classify(name);

    let fieldCount = 0;
    let relationCount = 0;
    const table = MAP_RE.exec(body)?.[1] ?? name;

    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, ''); // strip trailing comments
      if (/^\s*(@@|\/\/|$)/.test(line)) continue; // block attrs / comments / blank
      const field = FIELD_RE.exec(line);
      if (!field) continue;

      const [, fieldName, fieldType] = field;
      const isRelationField = modelNames.has(fieldType);

      if (!isRelationField) {
        fieldCount++;
        continue;
      }

      // Relation field. Only the side that OWNS the foreign key carries
      // `@relation(fields: [...])`; the inverse (a `Model[]` back-reference)
      // does not. Counting only the owning side yields one directed edge per FK
      // instead of a duplicate pair.
      if (RELATION_FIELDS_RE.test(line)) {
        relationCount++;
        edges.push({
          id: `${name}->${fieldType}:${fieldName}`,
          source: name,
          target: fieldType,
          field: fieldName,
        });
      }
    }

    nodes.push({
      id: name,
      table,
      group,
      color,
      fieldCount,
      relationCount,
    });
  }

  // Module rollup for the legend, ordered by node count desc for a stable UI.
  const byGroup = new Map<string, { color: string; count: number }>();
  for (const n of nodes) {
    const entry = byGroup.get(n.group) ?? { color: n.color, count: 0 };
    entry.count++;
    byGroup.set(n.group, entry);
  }
  const modules = [...byGroup.entries()]
    .map(([group, { color, count }]) => ({ group, color, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));

  return { generatedAt: null, nodes, edges, modules };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────
// Guarded so the pure `parseSchema` above can be imported by the controller
// without triggering a file write.
function main() {
  const schemaPath = join(__dirname, '..', 'prisma', 'schema.prisma');
  const outPath = join(__dirname, '..', 'src', 'blueprint', 'db-graph.generated.json');

  const schema = readFileSync(schemaPath, 'utf8');
  const graph = parseSchema(schema);
  graph.generatedAt = new Date().toISOString();

  writeFileSync(outPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');

  const misc = graph.nodes.filter((n) => n.group === 'Misc').map((n) => n.id);
  // eslint-disable-next-line no-console
  console.log(
    `[parse-schema] ${graph.nodes.length} models, ${graph.edges.length} FK edges, ` +
      `${graph.modules.length} modules → ${outPath}`,
  );
  if (misc.length) {
    // eslint-disable-next-line no-console
    console.warn(`[parse-schema] ungrouped (Misc): ${misc.join(', ')}`);
  }
}

if (require.main === module) main();
