import { DealerStatus, PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  SEED_MAKES,
  SEED_MODELS,
  SEED_TRIMS,
  SEED_ENGINES,
} from './seed-data/vehicle-catalog.seed';
import {
  SEED_CATEGORIES,
  SEED_OTHER_CATEGORIES,
  SEED_ROOT_CATEGORIES,
  SEED_DEALERS,
  fiscalDataFor,
} from './seed-data/catalog-reference.seed';
import { localizedNamesFor } from './seed-data/category-names.seed';
import { NODE_SEED as FITMENT_NODE_SEED } from '../admin/fitment-studio/fitment-node.config';
import {
  seedLaunchCatalog,
  launchDatasetIsEmpty,
} from './seed-launch-catalog';
import {
  LEGAL_V1_EFFECTIVE_AT,
  legalDocumentSeed,
} from './seed-data/legal-documents.seed';
import { decideLegalSeedAction } from './seed-data/legal-seed-decision';

const prisma = new PrismaClient();

/**
 * SMS operator pricing reference (Uzbek MSISDN operator codes). Each `prefix` is
 * the 2-digit code that follows the 998 country code; `priceUzs` is the per-SMS
 * price used by the accounting layer. Data only — resolution logic lives in
 * SmsOperatorResolver, historical cost is snapshotted onto SmsMessage.
 */
const SEED_SMS_OPERATORS: {
  name: string;
  displayName: string;
  priceUzs: number;
  prefixes: string[];
}[] = [
  { name: 'humans', displayName: 'Humans', priceUzs: 60, prefixes: ['33'] },
  { name: 'mobiuz', displayName: 'MobiUz', priceUzs: 100, prefixes: ['97', '88', '87'] },
  { name: 'perfectum', displayName: 'Perfectum', priceUzs: 110, prefixes: ['98', '80'] },
  { name: 'uzmobile', displayName: 'UZMOBILE', priceUzs: 140, prefixes: ['95', '99', '77'] },
  { name: 'beeline', displayName: 'Beeline', priceUzs: 155, prefixes: ['90', '91', '92', '20'] },
  { name: 'ucell', displayName: 'Ucell', priceUzs: 160, prefixes: ['93', '94', '55', '50', '71'] },
];

/**
 * Phase 2A — reference-data seed. Idempotent (every write is an upsert keyed on
 * the stable frontend id), so `npm run seed` can be run repeatedly and converges.
 *
 * Order respects FK dependencies: makes → models → trims (both FK back to
 * make/model). Engines are independent. Categories/dealers are independent
 * reference rows.
 *
 * DATA ONLY — this file creates NO API and changes NO schema. All values come
 * verbatim from the frontend source of truth (see the seed-data/*.ts headers).
 */

/**
 * Optional, opt-in bootstrap admin. There are NO hardcoded credentials: an admin
 * is created only when BOTH `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are
 * provided via the environment. This makes it safe to run the seed against
 * production for reference data without ever planting a default/known-credential
 * admin account.
 *
 * Behavior:
 *   • neither var set        → skip (no admin touched) — the common case.
 *   • both vars set          → upsert an ADMIN with the given credentials.
 *   • only one var set       → fail (incomplete configuration; do not guess).
 *   • password too short     → fail (min 12 chars) so a weak bootstrap password
 *                              cannot slip into production.
 */
async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email && !password) {
    console.log('[seed] SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD not set — skipping admin bootstrap.');
    return;
  }
  if (!email || !password) {
    throw new Error(
      'Incomplete admin bootstrap: set BOTH SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or neither.',
    );
  }
  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.appUser.upsert({
    where: { email },
    update: { passwordHash, role: Role.ADMIN },
    create: { email, passwordHash, role: Role.ADMIN },
  });
  console.log(`[seed] bootstrap admin ensured for ${email}`);
}

async function seedVehicleCatalog() {
  // Makes first (models/trims FK to them).
  for (const m of SEED_MAKES) {
    await prisma.vehicleMake.upsert({
      where: { id: m.id },
      update: { name: m.name, sortOrder: m.sortOrder },
      create: { id: m.id, name: m.name, sortOrder: m.sortOrder },
    });
  }
  // Models (FK → make). sortOrder carries the frontend catalog order.
  for (const m of SEED_MODELS) {
    await prisma.vehicleModelRef.upsert({
      where: { id: m.id },
      update: { makeId: m.makeId, name: m.name, sortOrder: m.sortOrder },
      create: { id: m.id, makeId: m.makeId, name: m.name, sortOrder: m.sortOrder },
    });
  }
  // Trims (FK → model; id already encodes the frontend generation).
  for (const t of SEED_TRIMS) {
    await prisma.vehicleTrim.upsert({
      where: { id: t.id },
      update: { modelId: t.modelId, name: t.name, sortOrder: t.sortOrder },
      create: { id: t.id, modelId: t.modelId, name: t.name, sortOrder: t.sortOrder },
    });
  }
  // Engines (independent).
  for (const e of SEED_ENGINES) {
    await prisma.vehicleEngine.upsert({
      where: { id: e.id },
      update: { name: e.name, displacementCc: e.displacementCc, fuelType: e.fuelType ?? undefined, sortOrder: e.sortOrder },
      create: { id: e.id, name: e.name, displacementCc: e.displacementCc, fuelType: e.fuelType ?? undefined, sortOrder: e.sortOrder },
    });
  }
}

async function seedCategories() {
  // The category TREE: 8 level-0 vehicle categories, then the 12 canonical
  // level-1 main categories parented under them, then the fallback bucket.
  // Matches the migration exactly so a fresh DB and a migrated DB converge.
  //
  // Idempotent: every row is upserted by its stable slug-shaped id, so running
  // the seed repeatedly updates in place and never duplicates.
  //
  // Roots FIRST — the main categories below reference them as parents.
  for (const c of SEED_ROOT_CATEGORIES) {
    await prisma.partCategory.upsert({
      where: { id: c.id },
      update: {
        name: c.name,
        ...localizedNamesFor(c.id, c.name),
        slug: c.slug,
        color: c.color,
        iconKey: c.iconKey,
        sortOrder: c.sortOrder,
        parentId: null,
        level: 0,
        isActive: true,
        // Known MXIK / package codes for the childless roots a seller can pick
        // directly (transmission, heating-and-cooling). Absent for every other
        // root, which therefore keeps whatever an admin configured.
        ...fiscalDataFor(c.id),
      },
      create: {
        id: c.id,
        name: c.name,
        ...localizedNamesFor(c.id, c.name),
        slug: c.slug,
        color: c.color,
        iconKey: c.iconKey,
        sortOrder: c.sortOrder,
        level: 0,
        isActive: true,
        ...fiscalDataFor(c.id),
      },
    });
  }

  for (const c of SEED_CATEGORIES) {
    await prisma.partCategory.upsert({
      where: { id: c.id },
      update: {
        name: c.name,
        ...localizedNamesFor(c.id, c.name),
        slug: c.slug,
        color: c.color,
        iconKey: c.iconKey,
        mainCategory: c.mainCategory,
        sortOrder: c.sortOrder,
        parentId: c.parentId,
        level: c.level,
        isActive: true,
        // The leaf categories carry the fiscal data — this is where a seller's
        // listing actually lands (see CATEGORY_FISCAL_DATA).
        ...fiscalDataFor(c.id),
      },
      create: {
        id: c.id,
        name: c.name,
        ...localizedNamesFor(c.id, c.name),
        slug: c.slug,
        color: c.color,
        iconKey: c.iconKey,
        mainCategory: c.mainCategory,
        sortOrder: c.sortOrder,
        parentId: c.parentId,
        level: c.level,
        isActive: true,
        ...fiscalDataFor(c.id),
      },
    });
  }

  // The admin-managed "Другое" catalogue (level 1, under the `other` root). A
  // STARTING set only — the admin panel owns these from here on.
  for (const c of SEED_OTHER_CATEGORIES) {
    await prisma.partCategory.upsert({
      where: { id: c.id },
      update: {
        name: c.name,
        ...localizedNamesFor(c.id, c.name),
        slug: c.id,
        sortOrder: c.sortOrder,
        parentId: 'other',
        level: 1,
        isActive: true,
      },
      create: {
        id: c.id,
        name: c.name,
        ...localizedNamesFor(c.id, c.name),
        slug: c.id,
        sortOrder: c.sortOrder,
        parentId: 'other',
        level: 1,
        isActive: true,
      },
    });
  }

  // The fallback bucket for unclassified buyer parts. Parked at level 1 (though
  // parentless) so it is NOT offered to sellers as a root category, while
  // remaining a valid catalog_parts.category_id target. Mirrors the migration.
  await prisma.partCategory.upsert({
    where: { id: 'cat_uncategorized' },
    update: { isActive: true, level: 1 },
    create: {
      id: 'cat_uncategorized',
      name: 'Uncategorized',
      ...localizedNamesFor('cat_uncategorized', 'Uncategorized'),
      slug: 'uncategorized',
      sortOrder: 999,
      level: 1,
      isActive: true,
    },
  });
}

async function seedDealers() {
  for (const d of SEED_DEALERS) {
    const fields = {
      name: d.name,
      ratingAvg: d.ratingAvg,
      // SEED_DEALERS are the curated MATOR-certified dealers by definition, so
      // the curated marker is asserted here (idempotently). GET /v1/dealers
      // filters on this flag, never on field presence.
      isCurated: true,
      initial: d.initial,
      color: d.color,
      orders: d.orders,
      years: d.years,
      // Admin console state. These dealers are live, human-verified storefronts,
      // so they land ACTIVE and certified rather than in the moderation queue —
      // the same conclusion the migration reaches when backfilling an existing
      // database. Without this, a freshly seeded DB would show every curated
      // dealer as PENDING. brandColor mirrors `color` so both surfaces agree.
      status: DealerStatus.ACTIVE,
      certified: true,
      brandColor: d.color,
    };
    await prisma.catalogSeller.upsert({
      where: { id: d.id },
      update: fields,
      create: { id: d.id, ...fields },
    });
  }
}

/**
 * SMS operators + their MSISDN prefixes. Idempotent: operators upsert on their
 * unique `name`, prefixes upsert on their unique `prefix` (re-pointing to the
 * owning operator if it ever moved). Re-running converges without duplicates.
 */
async function seedSmsOperators() {
  for (const op of SEED_SMS_OPERATORS) {
    const operator = await prisma.smsOperator.upsert({
      where: { name: op.name },
      update: { displayName: op.displayName, priceUzs: op.priceUzs, isActive: true },
      create: { name: op.name, displayName: op.displayName, priceUzs: op.priceUzs },
    });
    for (const prefix of op.prefixes) {
      await prisma.smsOperatorPrefix.upsert({
        where: { prefix },
        update: { operatorId: operator.id },
        create: { prefix, operatorId: operator.id },
      });
    }
  }
}

/**
 * Seed the 7 VehicleNode hotspots for the 3D Fitment Studio (idempotent, keyed
 * on the unique category). Coordinates MUST match the admin three.js scene so DB
 * nodes line up with the model (see admin/fitment-studio/fitment-node.config.ts).
 */
async function seedFitmentNodes() {
  for (const n of FITMENT_NODE_SEED) {
    await prisma.vehicleNode.upsert({
      where: { category: n.category },
      update: {
        name: n.name,
        positionX: n.positionX,
        positionY: n.positionY,
        positionZ: n.positionZ,
      },
      create: n,
    });
  }
}

/**
 * Verify the seeded shape and report it. Read-only — this asserts nothing and
 * fails nothing, it makes the outcome of a run inspectable: the category tree's
 * parent/child structure, and whether a commercial catalogue is present.
 */
async function verify() {
  const [roots, mains, orphans, oils, activeSales] = await Promise.all([
    prisma.partCategory.count({ where: { level: 0, isActive: true } }),
    prisma.partCategory.count({ where: { level: 1, isActive: true } }),
    // A level-1 category whose parent is missing would break the buyer grid.
    prisma.partCategory.count({ where: { level: 1, parentId: null, isActive: true } }),
    prisma.catalogPart.count({ where: { kind: 'MOTOR_OIL' } }),
    prisma.sale.count({ where: { isActive: true, deletedAt: null } }),
  ]);

  console.log('[seed] category tree:');
  console.table({
    root_categories: roots,
    main_categories: mains,
    // 'other' + 'cat_uncategorized' are parentless by design; anything beyond
    // those two is worth a look.
    parentless_level1: orphans,
  });
  console.log('[seed] catalogue:');
  console.table({
    part_brands: await prisma.partBrand.count(),
    catalog_parts: await prisma.catalogPart.count(),
    motor_oils: oils,
    active_sales: activeSales,
  });
}


/**
 * Legal documents — every version present in `docs/legal`, in ru, uz and en.
 *
 * The TEXT comes from `Backend/docs/legal/*.md` (see legal-documents.loader).
 * This function owns only publication state: which version exists in the
 * database, and which one is in force.
 *
 * Idempotent, and CAREFUL about what it overwrites:
 *   • document absent            → created, active.
 *   • present, still placeholder → title/content updated in place, so approved
 *                                  legal text can be dropped into the markdown
 *                                  and published with `npm run seed`, no code
 *                                  change and no version bump.
 *   • present, real text, same   → no-op.
 *   • present, real text, CHANGED→ LEFT ALONE, and reported loudly. Once
 *                                  approved wording is published (and possibly
 *                                  accepted by users), a re-run must never
 *                                  silently rewrite it — that would invalidate
 *                                  every acceptance pointing at it. Changing
 *                                  published text means adding a NEW version
 *                                  file, which is a deliberate act.
 *
 * The one-active-version-per-(type, locale) invariant is enforced by a partial
 * unique index (see the add_legal_documents migration). This seed publishes v1
 * ACTIVE only while no other version of that (type, locale) is active: once v2
 * has been published, re-running the seed must not resurrect v1 alongside it —
 * that would violate the index (crashing the seed) and, without it, would make
 * "which version is required?" ambiguous.
 */
async function seedLegalDocuments() {
  let created = 0;
  let refreshed = 0;
  let preserved = 0;
  let superseded = 0;
  // Files whose text no longer matches the approved row already in the database.
  const diverged: string[] = [];

  // Read at CALL time, not at import: a malformed source file must fail the
  // seed with the loader's diagnostic, not break every importer of this module.
  for (const doc of legalDocumentSeed()) {
    const existing = await prisma.legalDocument.findUnique({
      where: {
        type_version_locale: {
          type: doc.type,
          version: doc.version,
          locale: doc.locale,
        },
      },
    });

    // Is a DIFFERENT version of this document already in force? If so this seed
    // row has been superseded and must stay inactive — activating it would put
    // two active versions on one (type, locale) and trip the partial unique
    // index. This is what makes `npm run seed` safe to re-run after a version
    // bump instead of a landmine.
    const supersededByRow = await prisma.legalDocument.findFirst({
      where: {
        type: doc.type,
        locale: doc.locale,
        isActive: true,
        version: { not: doc.version },
      },
      select: { version: true },
    });
    if (supersededByRow) superseded++;

    // The overwrite rules live in decideLegalSeedAction so they can be tested
    // without a database — see legal-seed-decision.spec.ts.
    const action = decideLegalSeedAction(
      doc,
      existing,
      supersededByRow?.version ?? null,
    );

    switch (action.kind) {
      case 'create':
        await prisma.legalDocument.create({
          data: {
            type: doc.type,
            version: doc.version,
            locale: doc.locale,
            title: doc.title,
            content: doc.content,
            contentFormat: 'markdown',
            isActive: action.isActive,
            effectiveAt: LEGAL_V1_EFFECTIVE_AT,
          },
        });
        created++;
        break;

      case 'refresh':
        await prisma.legalDocument.update({
          where: { id: existing!.id },
          data: {
            title: doc.title,
            content: doc.content,
            isActive: action.isActive,
          },
        });
        refreshed++;
        break;

      case 'preserve':
        preserved++;
        break;

      case 'diverged':
        // Approved text was edited at the source after publication. Nothing is
        // written: the database holds what users accepted. Reported below.
        preserved++;
        diverged.push(`${doc.type} v${doc.version} (${doc.locale})`);
        break;
    }
  }

  console.log(
    `[seed] legal documents: ${created} created, ${refreshed} placeholder(s) refreshed, ` +
      `${preserved} approved document(s) left untouched` +
      (superseded > 0
        ? `, ${superseded} left INACTIVE (a newer version is already published).`
        : '.'),
  );

  if (diverged.length > 0) {
    // The source files were edited after the text was published. Nothing was
    // overwritten — publishing changed wording is a version bump, not an edit.
    console.warn(
      `[seed] WARNING: ${diverged.length} published document(s) differ from their ` +
        'source file and were NOT updated:\n' +
        diverged.map((d) => `         • ${d}`).join('\n') +
        '\n       The database holds the text users actually accepted, so it wins.\n' +
        '       To publish new wording, add a new version file\n' +
        '       (e.g. docs/legal/privacy-policy.v2.ru.md) and re-run `npm run seed`.\n' +
        '       To discard the edit, revert the source file to the published text.',
    );
  }

  const stillPlaceholder = await prisma.legalDocument.count({
    where: { isActive: true, content: { contains: '[PLACEHOLDER' } },
  });
  if (stillPlaceholder > 0) {
    // Loud, and it SHOULD be: users are being asked to consent to text nobody
    // has approved. Not an error — the structure is correct and the text is a
    // drop-in replacement — but this must not ship to production unnoticed.
    console.warn(
      `[seed] WARNING: ${stillPlaceholder} active legal document(s) still contain PLACEHOLDER text.\n` +
        '       Users would be consenting to wording no legal owner has approved.\n' +
        '       Replace the text in Backend/docs/legal/<document>.v<version>.<locale>.md\n' +
        '       and re-run `npm run seed` — no backend code change is required.',
    );
  }
}

async function main() {
  await seedAdmin();
  await seedVehicleCatalog();
  await seedCategories();
  await seedDealers();
  await seedSmsOperators();
  await seedFitmentNodes();
  await seedLegalDocuments();

  // The launch commercial catalogue (brands / dealers / products / sales). Runs
  // last: it references the categories and dealers seeded above.
  const launch = await seedLaunchCatalog(prisma);

  const counts = {
    vehicle_makes: await prisma.vehicleMake.count(),
    vehicle_models: await prisma.vehicleModelRef.count(),
    vehicle_trims: await prisma.vehicleTrim.count(),
    vehicle_engines: await prisma.vehicleEngine.count(),
    part_categories: await prisma.partCategory.count(),
    catalog_sellers: await prisma.catalogSeller.count(),
    sms_operators: await prisma.smsOperator.count(),
    sms_operator_prefixes: await prisma.smsOperatorPrefix.count(),
    vehicle_nodes: await prisma.vehicleNode.count(),
    legal_documents: await prisma.legalDocument.count(),
  };
  console.log('[seed] reference-data row counts:');
  console.table(counts);

  console.log('[seed] launch catalogue rows applied:');
  console.table(launch);

  if (launchDatasetIsEmpty()) {
    // Loud, but NOT an error: a reference-data-only bootstrap is a valid state.
    // The message names the exact file that has to be filled in, so this cannot
    // be mistaken for "the catalogue seeded successfully".
    console.warn(
      '[seed] NOTE: no launch commercial data is present. Brands, dealers, products and\n' +
        '       sales were NOT seeded because the real dataset has not been supplied.\n' +
        '       Populate src/prisma/seed-data/launch-catalog.seed.ts and re-run `npm run seed`.\n' +
        '       The loader is complete and idempotent — no code change is required.',
    );
  }

  await verify();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    // Surface a non-zero exit so a failed seed cannot be mistaken for success
    // (e.g. in `prisma migrate deploy && npm run seed` bootstrap pipelines).
    process.exit(1);
  });
