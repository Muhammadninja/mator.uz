/**
 * schema-blueprint.ts — Prisma schema → the 3D DB Blueprint payload.
 *
 * Emits the EXACT shape the design prototype consumes (see the handoff
 * `design_handoff_mator_db_blueprint_3d`), generated from the real schema:
 *
 *   DOMAINS   { id, label, color, note }[]                        (6 fixed)
 *   TABLES    { d, name, desc, cols: [key,name,type,note][] }[]   key ∈ ''|PK|FK|UQ|IDX
 *   RELATIONS [parent, "1 : N"|"1 : 1", child, fkColumn, onDelete][]
 *
 * Layout in the scene is DERIVED from this (tower = domain, height = degree,
 * arc = a RELATIONS row) — adding a table changes nothing but the schema.
 *
 * Dependency-free line parser (no @prisma/internals): Prisma's grammar for what
 * we need — model blocks, scalar/relation fields, `@relation(fields:…)`,
 * `@db.*`, `@map`, `@@map`, `@@index`, `@unique`, `@id` — is regular enough.
 */

// ── The 6 domains (design taxonomy, verbatim from the handoff) ─────────────────
export const DOMAINS = [
  { id: 'identity', label: 'Identity & Garage', color: '#3b82f6', note: 'Who is buying, where they ship, what they drive.' },
  { id: 'catalog', label: 'Catalog & Inventory', color: '#8b5cf6', note: 'Master parts, dealer listings, stock and media.' },
  { id: 'fitment', label: 'Vehicle & Fitment', color: '#06b6d4', note: 'Powers the 3D Fitment Studio and “Check if it fits”.' },
  { id: 'commerce', label: 'Commerce', color: '#22c55e', note: 'Cart → order → payment, plus service bookings.' },
  { id: 'engagement', label: 'Engagement', color: '#f59e0b', note: 'Notifications, AI chat, promotions.' },
  { id: 'platform', label: 'Platform & Audit', color: '#ef4444', note: 'Staff accounts, permissions, SMS, audit trail.' },
] as const;

type DomainId = (typeof DOMAINS)[number]['id'];

// Model → domain. Explicit map (exhaustive over the schema's 63 models); a
// name-rule fallback catches anything added later so nothing is orphaned.
const MODEL_DOMAIN: Record<string, DomainId> = {
  // identity & garage
  AppUser: 'identity', AuthIdentity: 'identity', RefreshToken: 'identity',
  EmailVerificationToken: 'identity', PhoneOtpRequest: 'identity',
  MyIdSession: 'identity', MyIdVerification: 'identity', Address: 'identity',
  Device: 'identity', Vehicle: 'identity', VehicleStatusEvent: 'identity',
  // vehicle & fitment
  VehicleMake: 'fitment', VehicleModelRef: 'fitment', VehicleTrim: 'fitment',
  VehicleEngine: 'fitment', Vehicle3dAsset: 'fitment', TuningVariant: 'fitment',
  VehicleNode: 'fitment', FitmentBinding: 'fitment', Brand: 'fitment', CarModel: 'fitment',
  // catalog & inventory
  Seller: 'catalog', Product: 'catalog', ProductImage: 'catalog', PartModel: 'catalog',
  OemCompatibility: 'catalog', Stock: 'catalog', ProductDraft: 'catalog',
  ProductDraftImage: 'catalog', PartCategory: 'catalog', PartBrand: 'catalog',
  CatalogSeller: 'catalog', CatalogPart: 'catalog', CatalogPartFit: 'catalog',
  PartCompatibility: 'catalog',
  // commerce (orders + service bookings)
  Cart: 'commerce', CartItem: 'commerce', Order: 'commerce', OrderItem: 'commerce',
  OrderStatusHistory: 'commerce', Payment: 'commerce', Sale: 'commerce', SaleTarget: 'commerce',
  ServiceProvider: 'commerce', ProviderSpecialization: 'commerce',
  ProviderSupportedMake: 'commerce', ProviderServiceOffering: 'commerce',
  ProviderWorkingHours: 'commerce', ProviderCertification: 'commerce',
  ProviderPortfolioItem: 'commerce', Booking: 'commerce', BookingService: 'commerce',
  // engagement
  Notification: 'engagement', NotificationPreference: 'engagement',
  AiSession: 'engagement', AiMessage: 'engagement',
  // platform & audit
  AppAdmin: 'platform', AdminAudit: 'platform', AdminRefreshToken: 'platform',
  AdminInvite: 'platform', SmsOperator: 'platform', SmsOperatorPrefix: 'platform',
  SmsMessage: 'platform',
};

function classify(model: string): DomainId {
  if (MODEL_DOMAIN[model]) return MODEL_DOMAIN[model];
  const m = model.toLowerCase();
  if (m.startsWith('admin') || m.includes('sms')) return 'platform';
  if (m.includes('provider') || m.includes('booking') || m.includes('order') || m.includes('cart') || m.includes('payment') || m.includes('sale')) return 'commerce';
  if (m.includes('vehicle') || m.includes('fitment') || m.includes('tuning')) return 'fitment';
  if (m.includes('notification') || m.includes('ai')) return 'engagement';
  if (m.includes('user') || m.includes('auth') || m.includes('address') || m.includes('device')) return 'identity';
  return 'catalog';
}

// ── Types ─────────────────────────────────────────────────────────────────────
export type BlueprintCol = [key: string, name: string, type: string, note: string];
export interface BlueprintTable {
  d: DomainId;
  name: string;
  desc: string;
  cols: BlueprintCol[];
}
export type BlueprintRelation = [parent: string, cardinality: string, child: string, fk: string, onDelete: string];
export interface BlueprintPayload {
  generatedAt: string | null;
  migrationVersion: string | null;
  domains: typeof DOMAINS;
  tables: BlueprintTable[];
  relations: BlueprintRelation[];
}

// ── Parsing internals ─────────────────────────────────────────────────────────
const MODEL_RE = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
const MAP_RE = /@map\("([^"]+)"\)/;
const TABLE_MAP_RE = /@@map\("([^"]+)"\)/;
const DB_TYPE_RE = /@db\.(\w+)(\([^)]*\))?/;
const RELATION_FIELDS_RE = /@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*\)/;
const ONDELETE_RE = /onDelete:\s*(\w+)/;
// Balanced enough for one level of nested parens, so `now()` / `uuid()` /
// `gen_random_uuid()` capture whole rather than truncating at the inner `(`.
const DEFAULT_RE = /@default\(((?:[^()]|\([^()]*\))*)\)/;

interface FieldRaw {
  field: string; // prisma field name
  baseType: string;
  isArray: boolean;
  isOptional: boolean;
  attrs: string;
}

interface ModelMeta {
  name: string;
  table: string;
  domain: DomainId;
  body: string;
  fields: FieldRaw[];
  colName: Map<string, string>; // prisma field → column name
  indexedFields: Set<string>; // fields appearing in @@index / @index
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

/** Map a Prisma scalar/@db type to a Postgres-flavoured label for the panel. */
function pgType(baseType: string, attrs: string, isArray: boolean, enums: Set<string>): string {
  let t: string;
  const db = DB_TYPE_RE.exec(attrs);
  if (db) {
    const name = db[1].toLowerCase();
    const arg = db[2] ?? '';
    const map: Record<string, string> = {
      varchar: 'varchar', timestamptz: 'timestamptz', decimal: 'numeric',
      uuid: 'uuid', text: 'text', date: 'date', char: 'char', jsonb: 'jsonb',
    };
    const cleanArg = arg.replace(/,\s+/g, ','); // "(14, 2)" → "(14,2)"
    t = (map[name] ?? name) + (name === 'timestamptz' ? '' : cleanArg);
    if (name === 'timestamptz') t = 'timestamptz';
  } else if (enums.has(baseType)) {
    t = snake(baseType);
  } else {
    const map: Record<string, string> = {
      String: 'text', Int: 'integer', BigInt: 'bigint', Boolean: 'boolean',
      DateTime: 'timestamptz', Decimal: 'numeric', Float: 'double precision',
      Json: 'jsonb', Bytes: 'bytea',
    };
    t = map[baseType] ?? baseType.toLowerCase();
  }
  return isArray ? t + '[]' : t;
}

/** Short human note from a scalar field's modifiers. */
function colNote(f: FieldRaw, isUnique: boolean, fkTarget: string | null): string {
  const parts: string[] = [];
  if (fkTarget) parts.push('→ ' + fkTarget);
  if (f.isOptional) parts.push('nullable');
  if (isUnique && !fkTarget) parts.push('unique');
  const def = DEFAULT_RE.exec(f.attrs);
  if (def) {
    let d = def[1].trim();
    if (/^".*"$/.test(d)) d = d.slice(1, -1); // drop quotes: "UZS" → UZS
    if (d === 'uuid()' || d === 'cuid()') d = ''; // surrogate PKs: uninteresting
    else if (d.length > 22) d = d.slice(0, 20) + '…';
    if (d) parts.push('default ' + d);
  }
  if (/@updatedAt/.test(f.attrs)) parts.push('on update');
  return parts.join(', ');
}

function parseModel(name: string, body: string): ModelMeta {
  const table = TABLE_MAP_RE.exec(body)?.[1] ?? snake(name);
  const domain = classify(name);
  const fields: FieldRaw[] = [];
  const colName = new Map<string, string>();
  const indexedFields = new Set<string>();

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trimEnd();
    if (!line.trim()) continue;

    // Block attributes: @@index([...]) / @@unique([...]) → mark indexed fields.
    const block = /^\s*@@(index|unique)\(\s*\[([^\]]+)\]/.exec(line);
    if (block) {
      for (const f of block[2].split(',')) indexedFields.add(f.trim());
      continue;
    }
    if (/^\s*@@/.test(line)) continue;

    const fm = /^\s{2}(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (!fm) continue;
    const [, field, baseType, arr, opt, attrs] = fm;
    fields.push({ field, baseType, isArray: !!arr, isOptional: !!opt, attrs: attrs ?? '' });
    colName.set(field, MAP_RE.exec(attrs ?? '')?.[1] ?? snake(field));
  }

  return { name, table, domain, body, fields, colName, indexedFields };
}

function onDeleteLabel(attrs: string, optional: boolean): string {
  const m = ONDELETE_RE.exec(attrs);
  const v = m?.[1] ?? (optional ? 'SetNull' : 'Restrict');
  return v === 'Cascade' ? 'cascade' : v === 'SetNull' ? 'set null' : 'restrict';
}

// ── Public builder ────────────────────────────────────────────────────────────
export function buildBlueprint(schema: string): BlueprintPayload {
  const modelNames = new Set<string>();
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{/gm)) modelNames.add(m[1]);
  const enumNames = new Set<string>();
  for (const m of schema.matchAll(/^enum\s+(\w+)\s*\{/gm)) enumNames.add(m[1]);

  const models: ModelMeta[] = [];
  for (const block of schema.matchAll(MODEL_RE)) {
    models.push(parseModel(block[1], block[2]));
  }
  const byName = new Map(models.map((m) => [m.name, m]));

  const relations: BlueprintRelation[] = [];
  // Per model: which scalar fields are FKs, and their parent "table.col" target.
  const fkInfo = new Map<string, Map<string, { parentTable: string; parentCol: string }>>();

  for (const model of models) {
    const fkMap = new Map<string, { parentTable: string; parentCol: string }>();
    for (const f of model.fields) {
      if (!modelNames.has(f.baseType)) continue; // scalar → not a relation
      const rel = RELATION_FIELDS_RE.exec(f.attrs);
      if (!rel) continue; // inverse back-reference (no fields:) → skip
      const fkField = rel[1].split(',')[0].trim();
      const parent = byName.get(f.baseType);
      if (!parent) continue;
      const fkCol = model.colName.get(fkField) ?? snake(fkField);
      // 1:1 when the FK scalar field is @unique, else 1:N.
      const fkDef = model.fields.find((x) => x.field === fkField);
      const unique = !!fkDef && /@unique/.test(fkDef.attrs);
      const card = unique ? '1 : 1' : '1 : N';
      const onDel = onDeleteLabel(f.attrs, !!fkDef?.isOptional);
      relations.push([parent.table, card, model.table, fkCol, onDel]);
      fkMap.set(fkField, { parentTable: parent.table, parentCol: 'id' });
    }
    fkInfo.set(model.name, fkMap);
  }

  const tables: BlueprintTable[] = models.map((model) => {
    const fkMap = fkInfo.get(model.name)!;
    const cols: BlueprintCol[] = [];
    for (const f of model.fields) {
      if (modelNames.has(f.baseType)) continue; // relation object field → not a column
      const isPk = /@id\b/.test(f.attrs);
      const isUnique = /@unique/.test(f.attrs);
      const fk = fkMap.get(f.field);
      const isIdx = model.indexedFields.has(f.field);
      const key = isPk ? 'PK' : fk ? 'FK' : isUnique ? 'UQ' : isIdx ? 'IDX' : '';
      const name = model.colName.get(f.field)!;
      const type = pgType(f.baseType, f.attrs, f.isArray, enumNames);
      const note = colNote(f, isUnique, fk ? `${fk.parentTable}.${fk.parentCol}` : null);
      cols.push([key, name, type, note]);
    }
    return { d: model.domain, name: model.table, desc: TABLE_NOTES[model.table] ?? '', cols };
  });

  return {
    generatedAt: null,
    migrationVersion: null,
    domains: DOMAINS,
    tables,
    relations,
  };
}

// Hand-written one-liners for the highest-traffic tables (design keeps these in
// a small notes map; everything else renders with no description). Keyed by the
// Postgres table name (@@map value).
const TABLE_NOTES: Record<string, string> = {
  app_users: 'Buyer account. Guest-first: a row is created lazily on first auth.',
  vehicles: "A user's saved cars. Drives fitment checks across the app.",
  catalog_parts: "A dealer's listed part — price, stock, cashback, OEM/GM numbers.",
  orders: 'Cart → order → payment. Status flow is payment-aware.',
  order_items: 'One line per part in an order, priced at purchase time.',
  payments: 'Payment attempts against an order (provider, status, amount).',
  vehicle_nodes: 'The fixed 3D hotspots on a car (front brakes, engine…).',
  fitment_bindings: 'Binds a catalog part to a vehicle node — the Fitment Studio core.',
  app_admins: 'Operator accounts for the admin panel (roles + audit).',
};
