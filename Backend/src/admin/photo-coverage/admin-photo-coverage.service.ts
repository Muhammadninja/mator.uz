import { Injectable } from '@nestjs/common';
import { Prisma, StockSourceSystem } from '@prisma/client';
import { clampLimit } from '../../common/pagination.util';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ListPhotoCoverageQueryDto,
  PhotoCoverageFilter,
} from './dto/list-photo-coverage.query.dto';
import {
  buildCategoryCoverage,
  coveragePct,
  CoverageCounts,
  displayablePhotos,
  HAS_DISPLAYABLE_PHOTO_SQL,
  primaryPhoto,
  likeContains,
  subtreeIds,
} from './photo-coverage.rules';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** CatalogPart ids the projection derives from a supply-side Stock row. */
const STOCK_PART_ID = /^part_stock_(\d+)$/;

/** The part fields one coverage row shows. No relation beyond its category. */
export const PHOTO_COVERAGE_ROW_SELECT = {
  id: true,
  title: true,
  oemNumbers: true,
  gmNumbers: true,
  images: true,
  category: {
    select: {
      id: true,
      parentId: true,
      name: true,
      nameRu: true,
      nameUz: true,
      nameEn: true,
    },
  },
} satisfies Prisma.CatalogPartSelect;

type PhotoCoverageRow = Prisma.CatalogPartGetPayload<{
  select: typeof PHOTO_COVERAGE_ROW_SELECT;
}>;

/** Wire row: the part, its numbers, its 1C code and what the app could show. */
export function presentPhotoCoverageRow(
  row: PhotoCoverageRow,
  code1c: string | null,
) {
  const primary = primaryPhoto(row.images);
  const photos = displayablePhotos(row.images);
  return {
    id: row.id,
    name: row.title,
    oem: row.oemNumbers[0] ?? row.gmNumbers[0] ?? null,
    oemNumbers: row.oemNumbers,
    gmNumbers: row.gmNumbers,
    code1c,
    category: row.category,
    // What the buyer's card shows: images[0] when it is displayable, else null
    // (the card then shows its "no photo" placeholder; it never falls back to a
    // later photo). This alone decides photoStatus, as the SQL count does.
    primaryPhoto: primary,
    // Every displayable entry, for the operator's viewer. It can be non-empty
    // while primaryPhoto is null: a broken first entry hides good later ones.
    photos,
    photoCount: photos.length,
    // Raw entries in catalog_parts.images, displayable or not.
    storedPhotoCount: row.images?.length ?? 0,
    photoStatus: primary !== null ? 'has_photo' : 'no_photo',
  };
}

/**
 * Admin photo-coverage console: how many buyer-catalog parts (CatalogPart) have
 * a photo the app can display, overall and per category, and the parts behind
 * each number. Read-only; it never touches a photo, a part or the buyer rules.
 *
 * Deliberately NOT built on the buyer API, which lists only parts that already
 * have a photo (BUYER_LISTED_PART). Every part counts here, whatever its dealer
 * status or price.
 *
 * Counting is one row per part: the photo test reads the first element of the
 * part's own `images` array (no JOIN to a photo table), so several photos never
 * count a part twice. Categories come from `category_id` and the live
 * `part_categories` tree — not from the stored main_category /
 * vehicle_category copies.
 */
@Injectable()
export class AdminPhotoCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  /** Overall totals plus every category with its own and subtree counts. */
  async summary() {
    const [groups, categories] = await Promise.all([
      this.prisma.$queryRaw<
        { categoryId: string; total: bigint; withPhotos: bigint }[]
      >(
        Prisma.sql`SELECT cp."category_id" AS "categoryId", COUNT(*)::bigint AS "total", COUNT(*) FILTER (WHERE ${HAS_DISPLAYABLE_PHOTO_SQL})::bigint AS "withPhotos" FROM "catalog_parts" cp GROUP BY cp."category_id"`,
      ),
      this.prisma.partCategory.findMany({
        select: {
          id: true,
          parentId: true,
          name: true,
          nameRu: true,
          nameUz: true,
          nameEn: true,
          isActive: true,
          sortOrder: true,
        },
      }),
    ]);

    const direct = new Map<string, CoverageCounts>();
    let total = 0;
    let withPhotos = 0;
    for (const g of groups) {
      const counts = {
        total: Number(g.total),
        withPhotos: Number(g.withPhotos),
      };
      direct.set(g.categoryId, counts);
      total += counts.total;
      withPhotos += counts.withPhotos;
    }

    return {
      success: true,
      data: {
        totals: {
          total,
          withPhotos,
          withoutPhotos: total - withPhotos,
          coveragePct: coveragePct(withPhotos, total),
        },
        categories: buildCategoryCoverage(categories, direct),
      },
    };
  }

  /** A page of parts, filtered by photo state, category subtree and searches. */
  async list(query: ListPhotoCoverageQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const offset = (page - 1) * limit;

    const where = await this.buildWhereSql(query);

    const countRows = await this.prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "catalog_parts" cp ${where}`,
    );
    const totalItems = Number(countRows[0]?.count ?? 0n);

    const idRows = await this.prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT cp."id" FROM "catalog_parts" cp ${where} ORDER BY cp."title" ASC, cp."id" ASC LIMIT ${limit} OFFSET ${offset}`,
    );
    const pageIds = idRows.map((r) => r.id);

    const rows = pageIds.length
      ? await this.prisma.catalogPart.findMany({
          where: { id: { in: pageIds } },
          select: PHOTO_COVERAGE_ROW_SELECT,
        })
      : [];
    const codes = await this.code1cByPartId(pageIds);
    const byId = new Map(rows.map((r) => [r.id, r]));

    return {
      success: true,
      data: pageIds
        .map((id) => byId.get(id))
        .filter((r): r is PhotoCoverageRow => r !== undefined)
        .map((r) => presentPhotoCoverageRow(r, codes.get(r.id) ?? null)),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * The Driver's Village 1C code of each page part that came from an import.
   * The two catalog worlds share no FK: a projected part's id is
   * `part_stock_<stocks.id>`, and the code is that Stock's `source_code`.
   */
  private async code1cByPartId(
    partIds: string[],
  ): Promise<Map<string, string>> {
    const stockIds = partIds
      .map((id) => STOCK_PART_ID.exec(id)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n <= 2_147_483_647);
    if (stockIds.length === 0) return new Map();
    const stocks = await this.prisma.stock.findMany({
      where: {
        id: { in: stockIds },
        sourceSystem: StockSourceSystem.DRIVERS_VILLAGE_1C,
      },
      select: { id: true, sourceCode: true },
    });
    const out = new Map<string, string>();
    for (const s of stocks) {
      if (s.sourceCode) out.set(`part_stock_${s.id}`, s.sourceCode);
    }
    return out;
  }

  /** WHERE shared by the count and the page query. Every value is a bound parameter. */
  private async buildWhereSql(
    query: ListPhotoCoverageQueryDto,
  ): Promise<Prisma.Sql> {
    const conds: Prisma.Sql[] = [];

    const photo = this.photoConditionSql(query.photo);
    if (photo) conds.push(photo);

    if (query.categoryId) {
      const edges = await this.prisma.partCategory.findMany({
        select: { id: true, parentId: true },
      });
      const ids = subtreeIds(edges, query.categoryId);
      conds.push(Prisma.sql`cp."category_id" IN (${Prisma.join(ids)})`);
    }

    const name = query.name?.trim();
    if (name) {
      conds.push(Prisma.sql`cp."title" ILIKE ${likeContains(name)}`);
    }

    const oem = query.oem?.trim();
    if (oem) {
      const like = likeContains(oem);
      // OEM and GM numbers are both what an operator calls the part number;
      // the id is the console's SKU.
      conds.push(Prisma.sql`(
        cp."id" ILIKE ${like}
        OR EXISTS (SELECT 1 FROM unnest(cp."oem_numbers") AS n WHERE n ILIKE ${like})
        OR EXISTS (SELECT 1 FROM unnest(cp."gm_numbers") AS n WHERE n ILIKE ${like})
      )`);
    }

    const code1c = query.code1c?.trim();
    if (code1c) {
      conds.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "stocks" s
        WHERE s."source_system" = ${StockSourceSystem.DRIVERS_VILLAGE_1C}::"StockSourceSystem"
          AND s."source_code" ILIKE ${likeContains(code1c)}
          AND cp."id" = 'part_stock_' || s."id"::text
      )`);
    }

    if (conds.length === 0) return Prisma.empty;
    return Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`;
  }

  private photoConditionSql(
    photo: PhotoCoverageFilter | undefined,
  ): Prisma.Sql | null {
    switch (photo) {
      case 'with':
        return HAS_DISPLAYABLE_PHOTO_SQL;
      case 'without':
        return Prisma.sql`NOT ${HAS_DISPLAYABLE_PHOTO_SQL}`;
      default:
        return null;
    }
  }
}
