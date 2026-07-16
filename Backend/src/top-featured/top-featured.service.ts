import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, FeaturedItem } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { formatUzs } from '../catalog/parts/part.presenter';
import { ListTopFeaturedDto } from './dto/list-top-featured.dto';

const DEFAULT_PAGE_SIZE = 24;
const SOCKET_CHANNEL = 'top_featured:catalog'; // matches frontend TOP_FEATURED_SOCKET_CHANNEL

// Filter dimensions the frontend renders (model / brand / color / condition).
const FILTER_DIMENSIONS = [
  { key: 'model', title: 'Model', column: 'model' },
  { key: 'brand', title: 'Brand', column: 'brand' },
  { key: 'color', title: 'Color', column: 'color' },
  { key: 'condition', title: 'Condition', column: 'condition' },
] as const;

/**
 * Read-only API over the FeaturedItem table (seeded, Phase 2A). Serves the
 * "Top Featured" grid the frontend expects at POST /v1/top-featured/list. No
 * hardcoded item arrays — items and the available-filter options come straight
 * from the table. Only active items are served, ordered by sortOrder.
 */
@Injectable()
export class TopFeaturedService {
  constructor(private readonly prisma: PrismaService) {}

  async list(dto: ListTopFeaturedDto) {
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? DEFAULT_PAGE_SIZE;
    const where = this.buildWhere(dto);

    const [total, items] = await Promise.all([
      this.prisma.featuredItem.count({ where }),
      this.prisma.featuredItem.findMany({
        where,
        orderBy: this.buildOrderBy(dto.sortBy),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: items.map(presentFeatured),
      total,
      page,
      pageSize,
      availableFilters: await this.availableFilters(),
      snapshotVersion: await this.snapshotVersion(),
      socketChannel: SOCKET_CHANNEL,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private buildWhere(dto: ListTopFeaturedDto): Prisma.FeaturedItemWhereInput {
    const and: Prisma.FeaturedItemWhereInput[] = [{ isActive: true }];
    const f = dto.filters ?? {};
    if (f.model) and.push({ model: f.model });
    if (f.brand) and.push({ brand: f.brand });
    if (f.color) and.push({ color: f.color });
    if (f.condition) and.push({ condition: f.condition });
    if (dto.search) {
      and.push({
        OR: [
          { title: { contains: dto.search, mode: 'insensitive' } },
          { brand: { contains: dto.search, mode: 'insensitive' } },
          { model: { contains: dto.search, mode: 'insensitive' } },
        ],
      });
    }
    return { AND: and };
  }

  private buildOrderBy(sortBy?: string): Prisma.FeaturedItemOrderByWithRelationInput {
    if (sortBy === 'newest') return { createdAt: 'desc' };
    if (sortBy === 'price_asc') return { priceUzs: 'asc' };
    if (sortBy === 'price_desc') return { priceUzs: 'desc' };
    return { sortOrder: 'asc' }; // 'featured' (default)
  }

  /**
   * Build the available-filter groups from the active items' distinct values,
   * each with a count — so the filter sheet only ever offers options that match
   * at least one item. Derived live from the table, never hardcoded.
   */
  private async availableFilters() {
    const active: Prisma.FeaturedItemWhereInput = { isActive: true };
    const groups = await Promise.all(
      FILTER_DIMENSIONS.map(async (dim) => {
        const grouped = await this.prisma.featuredItem.groupBy({
          by: [dim.column],
          where: active,
          _count: { _all: true },
        });
        const options = grouped
          .map((g) => ({ value: g[dim.column] as string | null, count: g._count._all }))
          .filter((o): o is { value: string; count: number } => !!o.value)
          .sort((a, b) => a.value.localeCompare(b.value))
          .map((o) => ({ value: o.value, label: o.value, count: o.count }));
        return { key: dim.key, title: dim.title, options };
      }),
    );
    return groups;
  }

  /**
   * snapshotVersion intentionally represents a deterministic hash of the current
   * FeaturedItem dataset. It is a PURE FUNCTION of persisted data (not timestamps
   * or request time) so clients can safely detect real snapshot changes.
   *
   * DO NOT replace this with Date.now(), a random value, or count+max(createdAt):
   *   • a time/random value breaks dedupe — clients would see false "updates"
   *     even when nothing changed;
   *   • count+max(createdAt) misses in-place UPDATEs because FeaturedItem has no
   *     updatedAt column, so an edited field would not bump the version.
   *
   * The hash is over the ACTIVE items' full content (all rendered fields) in a
   * stable id order, so: identical data → identical version, and ANY change
   * (create, delete, or an in-place UPDATE of any field) → a different version.
   * Verified on the test DB (stable / changes on edit / reverts on revert).
   */
  private async snapshotVersion() {
    const rows = await this.prisma.featuredItem.findMany({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    });
    // Explicit NUL delimiter (visible constant, not an invisible control char
    // embedded in source) between fields AND rows, so a field/row boundary is
    // unambiguous and content cannot shift across it undetected: without a
    // delimiter {title:'AB',badge:'C'} and {title:'A',badge:'BC'} both
    // serialize to 'ABC' and collide. NUL never occurs in the text columns.
    const SEP = String.fromCharCode(0);
    const canonical = rows
      .map((r) =>
        [
          r.id,
          r.sortOrder,
          r.title,
          r.badge ?? '',
          r.status ?? '',
          r.description ?? '',
          r.priceUzs != null ? r.priceUzs.toString() : '',
          r.model ?? '',
          r.brand ?? '',
          r.color ?? '',
          r.condition ?? '',
          r.oem ?? '',
        ].join(SEP),
      )
      .join(SEP);
    const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    return `featured-${rows.length}-${hash}`;
  }
}

/** Map a FeaturedItem row to the frontend TopFeaturedItem shape. */
export function presentFeatured(f: FeaturedItem) {
  return {
    id: f.id,
    badge: f.badge ?? '',
    status: f.status ?? '',
    title: f.title,
    description: f.description ?? '',
    price: f.priceUzs != null ? formatUzs(f.priceUzs) : '',
    model: f.model ?? '',
    brand: f.brand ?? '',
    color: f.color ?? '',
    condition: f.condition ?? '',
    oem: f.oem ?? undefined,
  };
}
