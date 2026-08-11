import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditEntity,
  DealerStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { clampLimit } from '../../common/pagination.util';
import { CloudinaryService } from '../../cloudinary/cloudinary.service';
import {
  ALLOWED_IMAGE_MIME,
  CloudinaryFolder,
  MAX_AVATAR_BYTES,
} from '../../common/image.constants';
import { AdminAuditContext } from '../auth/admin-auth.service';
import { AdminAuditService } from '../auth/admin-audit.service';
import {
  ADMIN_DEALER_DETAIL_SELECT,
  ADMIN_DEALER_LIST_SELECT,
  presentAdminDealerDetail,
  presentAdminDealerRow,
} from './admin-dealers.presenter';
import { CreateAdminDealerDto } from './dto/create-admin-dealer.dto';
import {
  AdminDealerSortField,
  AdminDealerStatusFilter,
  ListAdminDealersQueryDto,
} from './dto/list-admin-dealers.query.dto';
import { UpdateAdminDealerDto } from './dto/update-admin-dealer.dto';

// A dealer logo reuses the shared 5 MB image ceiling and MIME allowlist.
const MAX_DEALER_LOGO_BYTES = MAX_AVATAR_BYTES;

/**
 * The editable storefront presentation fields, mapped from the DTO name to the
 * Prisma column. Kept as data so create() and update() agree on exactly which
 * fields an operator owns, and update() can diff them generically.
 */
const PRESENTATION_COLUMN = {
  name: 'name',
  city: 'city',
  email: 'email',
  phone: 'phoneE164',
  brandColor: 'brandColor',
  initial: 'initial',
  logoUrl: 'logoUrl',
  orders: 'orders',
  years: 'years',
} as const;
type PresentationField = keyof typeof PRESENTATION_COLUMN;

const DEFAULT_ADMIN_DEALER_LIMIT = 20;
const MAX_ADMIN_DEALER_LIMIT = 100;
// Minimum digits before a search term is treated as a (partial) phone number —
// same threshold as the orders and users consoles.
const MIN_PHONE_SEARCH_DIGITS = 4;

/** Wire vocabulary → the real DealerStatus enum. */
const STATUS_BY_WIRE: Record<AdminDealerStatusFilter, DealerStatus> = {
  active: DealerStatus.ACTIVE,
  pending: DealerStatus.PENDING,
  suspended: DealerStatus.SUSPENDED,
};

/**
 * Whitelist mapping the accepted sort field onto the real Prisma column.
 * `skus` has no column of its own — it is a relation count — so it sorts via
 * Prisma's `_count` ordering rather than a scalar, and is handled separately.
 */
const SORT_COLUMN: Record<
  Exclude<AdminDealerSortField, 'skus'>,
  keyof Prisma.CatalogSellerOrderByWithRelationInput
> = {
  joinedAt: 'joinedAt',
  name: 'name',
  gmvUzs: 'gmvUzs',
  orders: 'ordersCount',
};

/** The editable-field mutations, and the audit verb each one records. */
const BADGE_ACTIONS = {
  certified: {
    on: AdminAuditAction.DEALER_CERTIFIED_ENABLED,
    off: AdminAuditAction.DEALER_CERTIFIED_DISABLED,
  },
  lowestPrice: {
    on: AdminAuditAction.DEALER_LOWEST_PRICE_ENABLED,
    off: AdminAuditAction.DEALER_LOWEST_PRICE_DISABLED,
  },
} as const;

/**
 * Admin/operator dealer console. Backs /v1/admin/dealers: the moderation queue
 * and the certified/lowest-price badges over the CatalogSeller table — the same
 * rows the public GET /v1/dealers storefront reads, so a change here is
 * immediately visible to the buyer-facing catalog.
 *
 * Every mutation is audited, and the audit entry is written INSIDE the same
 * transaction as the change (AdminAuditService.record takes the `tx`). A dealer
 * can therefore never be suspended without a record of who did it, and a rolled
 * back change leaves no misleading entry.
 *
 * State machine — the only legal transitions:
 *   PENDING   → ACTIVE     (approve)
 *   ACTIVE    → SUSPENDED  (suspend)
 *   SUSPENDED → ACTIVE     (reactivate)
 * Anything else is a 400. The transitions are checked against the row read in
 * the same transaction, so two concurrent approvals cannot both succeed.
 */
@Injectable()
export class AdminDealersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * Create a curated storefront from the console. A dealer added here is a real,
   * operator-vetted business meant to go live, so unless the body says otherwise
   * it lands ACTIVE + certified and is marked `isCurated` — the three conditions
   * GET /v1/dealers filters on — so it appears in the app's MATOR Certified rail
   * immediately. The id is a slug of the name, made unique with a numeric suffix.
   */
  async create(dto: CreateAdminDealerDto, ctx: AdminAuditContext) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Name is required');

    const id = await this.uniqueDealerId(slugify(name));
    const status = dto.status ? STATUS_BY_WIRE[dto.status] : DealerStatus.ACTIVE;
    // Certification is only meaningful for a live dealer; a non-active one is
    // never certified (the same invariant suspend enforces).
    const certified =
      status === DealerStatus.ACTIVE ? (dto.certified ?? true) : false;
    const lowestPrice =
      status === DealerStatus.ACTIVE ? (dto.lowestPrice ?? false) : false;
    const color = dto.brandColor?.trim() || null;
    const initial =
      dto.initial?.trim() || name.charAt(0).toUpperCase() || null;

    await this.prisma.$transaction(async (tx) => {
      await tx.catalogSeller.create({
        data: {
          id,
          name,
          isCurated: true,
          city: dto.city?.trim() || null,
          email: dto.email?.trim() || null,
          phoneE164: dto.phone?.trim() || null,
          // brandColor is the console accent; `color` is the legacy storefront
          // field GET /v1/dealers returns. Point both at the same value on
          // create so neither surface renders a colourless tile.
          brandColor: color,
          color,
          initial,
          logoUrl: dto.logoUrl?.trim() || null,
          orders: dto.orders?.trim() || null,
          years: dto.years ?? null,
          certified,
          lowestPrice,
          status,
          // Налоговые данные — optional at creation. Left NULL when absent
          // rather than defaulted: an unconfigured dealer must be refused at
          // Payme checkout, not silently fiscalized as 0% VAT.
          tin: dto.tin?.trim() || null,
          vatPercent: dto.vatPercent ?? null,
        },
      });

      await this.recordDealerAudit(tx, {
        action: AdminAuditAction.DEALER_CREATED,
        newValues: { id, name, status, certified, lowestPrice },
        dealer: { id, name },
        ctx,
      });
    });

    return this.getOne(id);
  }

  /**
   * Upload a dealer's brand logo and return its hosted URL. Reuses the shared
   * Cloudinary image store (no new upload path), with the same type/size rules
   * as avatars. The caller passes the returned URL back as `logoUrl` on create
   * or update — storage and the row write stay separate so a failed DB write
   * never strands a half-created dealer holding an orphan upload.
   */
  async uploadLogo(file?: {
    buffer: Buffer;
    mimetype: string;
    size: number;
  }): Promise<{ logoUrl: string }> {
    if (!file || !file.buffer?.length) {
      throw new UnsupportedMediaTypeException('An image file is required.');
    }
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        'Unsupported image type. Allowed: JPEG, PNG, WebP.',
      );
    }
    if (file.size > MAX_DEALER_LOGO_BYTES) {
      throw new PayloadTooLargeException('Image exceeds the 5 MB size limit.');
    }
    // CloudinaryService uploads with `format: 'png'`, so even an SVG/WebP source
    // is stored and delivered as a PNG the React Native <Image> can render.
    const uploaded = await this.cloudinary.uploadBuffer(
      file.buffer,
      CloudinaryFolder.DEALER_LOGOS,
    );
    return { logoUrl: uploaded.url };
  }

  /** A URL-safe, unique id for a new dealer, derived from its name. */
  private async uniqueDealerId(base: string): Promise<string> {
    const slug = (base || 'dealer').slice(0, 56);
    let candidate = slug;
    let n = 2;
    while (
      await this.prisma.catalogSeller.findUnique({
        where: { id: candidate },
        select: { id: true },
      })
    ) {
      candidate = `${slug}-${n++}`;
    }
    return candidate;
  }

  async list(query: ListAdminDealersQueryDto) {
    const page = query.page ?? 1;
    const limit = clampLimit(
      query.limit,
      DEFAULT_ADMIN_DEALER_LIMIT,
      MAX_ADMIN_DEALER_LIMIT,
    );
    const sortField = query.sort ?? 'joinedAt';
    const direction = query.order ?? 'desc';

    const where: Prisma.CatalogSellerWhereInput = {};
    if (query.status) where.status = STATUS_BY_WIRE[query.status];
    const search = this.buildSearch(query.search);
    if (search) where.OR = search;

    // Newest dealers first by default. The secondary `id` key makes the order
    // total: without it, rows sharing a joinedAt (every row backfilled by the
    // migration shares one) could be returned in a different order per page and
    // a dealer could be shown twice or skipped while paging.
    const orderBy: Prisma.CatalogSellerOrderByWithRelationInput[] =
      sortField === 'skus'
        ? [{ parts: { _count: direction } }, { id: 'asc' }]
        : [{ [SORT_COLUMN[sortField]]: direction }, { id: 'asc' }];

    const [dealers, totalItems] = await this.prisma.$transaction([
      this.prisma.catalogSeller.findMany({
        where,
        select: ADMIN_DEALER_LIST_SELECT,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.catalogSeller.count({ where }),
    ]);

    return {
      success: true,
      data: dealers.map(presentAdminDealerRow),
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  async getOne(id: string) {
    const dealer = await this.prisma.catalogSeller.findUnique({
      where: { id },
      select: ADMIN_DEALER_DETAIL_SELECT,
    });
    if (!dealer) throw new NotFoundException('Dealer not found');
    return { success: true, data: presentAdminDealerDetail(dealer) };
  }

  /**
   * Update the editable fields. The DTO is the whitelist — with the global
   * ValidationPipe's `forbidNonWhitelisted`, a body naming anything else is
   * already rejected with 400 before reaching here.
   *
   * Each changed field produces its OWN audit entry with the specific verb
   * ("certified enabled", "lowest-price disabled"), so the trail reads as what
   * actually happened rather than a generic "updated". A field set to the value
   * it already holds is not a change and is not audited.
   */
  async update(id: string, dto: UpdateAdminDealerDto, ctx: AdminAuditContext) {
    const hasPresentation = (
      Object.keys(PRESENTATION_COLUMN) as PresentationField[]
    ).some((f) => dto[f] !== undefined);
    if (
      !hasPresentation &&
      dto.certified === undefined &&
      dto.lowestPrice === undefined &&
      dto.status === undefined &&
      dto.tin === undefined &&
      dto.vatPercent === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }

    await this.prisma.$transaction(async (tx) => {
      const dealer = await this.requireDealer(tx, id);

      const data: Prisma.CatalogSellerUpdateInput = {};
      const entries: Array<{
        action: AdminAuditAction;
        previousValues: Prisma.InputJsonValue;
        newValues: Prisma.InputJsonValue;
      }> = [];

      for (const field of ['certified', 'lowestPrice'] as const) {
        const next = dto[field];
        if (next === undefined || next === dealer[field]) continue;
        data[field] = next;
        entries.push({
          action: next ? BADGE_ACTIONS[field].on : BADGE_ACTIONS[field].off,
          previousValues: { [field]: dealer[field] },
          newValues: { [field]: next },
        });
      }

      if (dto.status !== undefined) {
        const next = STATUS_BY_WIRE[dto.status];
        if (next !== dealer.status) {
          // Routed through the same transition table the dedicated endpoints
          // use, so PATCH cannot reach a state they forbid (e.g. straight from
          // PENDING to SUSPENDED).
          this.assertTransition(dealer.status, next);
          data.status = next;
          data.suspendedReason =
            next === DealerStatus.SUSPENDED ? (dto.reason?.trim() ?? null) : null;
          entries.push({
            action: auditActionFor(dealer.status, next),
            previousValues: { status: dealer.status },
            newValues: { status: next },
          });
        }
      }

      // Storefront presentation edits (name, city, logo, …) are collected into a
      // single DEALER_UPDATED entry: they are descriptive corrections, not the
      // moderation actions the badge/status verbs describe. A field set to the
      // value it already holds is skipped, so no no-op entry is written.
      const presPrev: Record<string, unknown> = {};
      const presNext: Record<string, unknown> = {};
      for (const field of Object.keys(
        PRESENTATION_COLUMN,
      ) as PresentationField[]) {
        const raw = dto[field];
        if (raw === undefined) continue;
        const column = PRESENTATION_COLUMN[field];
        const next =
          field === 'years'
            ? ((raw as number | null) ?? null)
            : (typeof raw === 'string' ? raw.trim() : '') || null;
        if (field === 'name' && !next) {
          throw new BadRequestException('Name cannot be empty');
        }
        const current =
          (dealer as Record<string, unknown>)[column] ?? null;
        if (next === current) continue;
        (data as Record<string, unknown>)[column] = next;
        // Keep the legacy storefront accent (`color`, returned by GET /v1/dealers)
        // in step with the console accent so the app card repaints too.
        if (field === 'brandColor') {
          (data as Record<string, unknown>).color = next;
        }
        presPrev[field] = current;
        presNext[field] = next;
      }
      // Налоговые данные. Handled apart from the presentation loop because
      // neither field is a string to be trimmed into a column of the same
      // shape: `tin` clears on an empty string, and `vatPercent` is a Decimal
      // that must be COMPARED numerically (`new Decimal(12) !== 12`), or every
      // no-op save would look like a change and write a spurious audit entry.
      // They join the same DEALER_UPDATED entry — one operator edit, one row in
      // the trail — while status/badges keep their own verbs.
      if (dto.tin !== undefined) {
        const next = dto.tin.trim() || null;
        if (next !== dealer.tin) {
          data.tin = next;
          presPrev.tin = dealer.tin;
          presNext.tin = next;
        }
      }
      if (dto.vatPercent !== undefined) {
        const current =
          dealer.vatPercent === null ? null : Number(dealer.vatPercent);
        if (dto.vatPercent !== current) {
          data.vatPercent = dto.vatPercent;
          presPrev.vatPercent = current;
          presNext.vatPercent = dto.vatPercent;
        }
      }

      if (Object.keys(presNext).length > 0) {
        entries.push({
          action: AdminAuditAction.DEALER_UPDATED,
          previousValues: presPrev as Prisma.InputJsonValue,
          newValues: presNext as Prisma.InputJsonValue,
        });
      }

      // Every field arrived already holding the requested value: no write, and
      // nothing to audit. Returning early keeps the trail free of no-op entries.
      if (entries.length === 0) return;

      await tx.catalogSeller.update({ where: { id }, data });
      for (const entry of entries) {
        await this.recordDealerAudit(tx, {
          ...entry,
          dealer,
          ctx,
          reason: data.status === DealerStatus.SUSPENDED ? dto.reason : null,
        });
      }
    });

    return this.getOne(id);
  }

  /** PENDING → ACTIVE. Any other current status is a 400. */
  async approve(id: string, ctx: AdminAuditContext) {
    return this.transition(id, DealerStatus.ACTIVE, ctx);
  }

  /** ACTIVE → SUSPENDED, persisting the reason. */
  async suspend(id: string, ctx: AdminAuditContext, reason?: string) {
    return this.transition(id, DealerStatus.SUSPENDED, ctx, reason);
  }

  /** SUSPENDED → ACTIVE, clearing the suspension reason. */
  async reactivate(id: string, ctx: AdminAuditContext) {
    return this.transition(id, DealerStatus.ACTIVE, ctx);
  }

  /**
   * The one write path for a status change. Reads the dealer, checks the
   * transition and writes the row + its audit entry in a single transaction, so
   * two concurrent approvals cannot both observe PENDING and both succeed.
   */
  private async transition(
    id: string,
    next: DealerStatus,
    ctx: AdminAuditContext,
    reason?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const dealer = await this.requireDealer(tx, id);
      this.assertTransition(dealer.status, next);

      const trimmedReason =
        next === DealerStatus.SUSPENDED ? (reason?.trim() ?? null) : null;

      // Suspending a dealer REVOKES its trust badges: a suspended storefront must
      // never remain MATOR Certified or advertise a lowest-price guarantee. They
      // are cleared in the same write so the public /v1/dealers storefront and the
      // admin console can never show a suspended-but-certified dealer. A later
      // reactivation deliberately does NOT restore them — the dealer re-earns
      // certification, it is not automatically reinstated.
      const clearBadges =
        next === DealerStatus.SUSPENDED &&
        (dealer.certified || dealer.lowestPrice);

      await tx.catalogSeller.update({
        where: { id },
        data: {
          status: next,
          // Cleared on any non-suspending transition, so a reactivated dealer
          // never carries the reason it was once suspended for.
          suspendedReason: trimmedReason,
          ...(clearBadges ? { certified: false, lowestPrice: false } : {}),
        },
      });

      await this.recordDealerAudit(tx, {
        action: auditActionFor(dealer.status, next),
        // The audit snapshot includes the revoked badges so the trail shows the
        // suspension also stripped certification, not just the status flip.
        previousValues: {
          status: dealer.status,
          ...(clearBadges
            ? { certified: dealer.certified, lowestPrice: dealer.lowestPrice }
            : {}),
        },
        newValues: {
          status: next,
          ...(clearBadges ? { certified: false, lowestPrice: false } : {}),
        },
        dealer,
        ctx,
        reason: trimmedReason,
      });
    });

    return this.getOne(id);
  }

  /**
   * Reject an illegal state change with a message naming both states, so the
   * console can show the operator why (e.g. approving an already-active dealer).
   */
  private assertTransition(from: DealerStatus, to: DealerStatus): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new BadRequestException(
        `Cannot change dealer status from ${from.toLowerCase()} to ${to.toLowerCase()}`,
      );
    }
  }

  /** Load the fields a mutation needs, or 404. Runs inside the caller's tx. */
  private async requireDealer(tx: Prisma.TransactionClient, id: string) {
    const dealer = await tx.catalogSeller.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        status: true,
        certified: true,
        lowestPrice: true,
        // Presentation columns, so update() can diff an edit against the current
        // value and skip a no-op.
        city: true,
        email: true,
        phoneE164: true,
        brandColor: true,
        initial: true,
        logoUrl: true,
        orders: true,
        years: true,
        // Налоговые данные, so an edit can be diffed against the stored values.
        tin: true,
        vatPercent: true,
      },
    });
    if (!dealer) throw new NotFoundException('Dealer not found');
    return dealer;
  }

  /** One audit entry for a dealer mutation, written in the caller's tx. */
  private async recordDealerAudit(
    tx: Prisma.TransactionClient,
    params: {
      action: AdminAuditAction;
      // Omitted on a creation — there is no prior state. The audit layer maps a
      // missing previousValues to a DB null.
      previousValues?: Prisma.InputJsonValue;
      newValues: Prisma.InputJsonValue;
      dealer: { id: string; name: string };
      ctx: AdminAuditContext;
      reason?: string | null;
    },
  ): Promise<void> {
    await this.audit.record(
      {
        action: params.action,
        actor: params.ctx.actor,
        actorLabel: params.ctx.actorLabel,
        target: {
          entity: AdminAuditEntity.DEALER,
          id: params.dealer.id,
          name: params.dealer.name,
        },
        previousValues: params.previousValues,
        newValues: params.newValues,
        reason: params.reason ?? null,
        ip: params.ctx.ip,
        userAgent: params.ctx.userAgent,
      },
      tx,
    );
  }

  /**
   * Build the search OR-clause across dealer/store name, city and email — all
   * columns on the dealer row itself, so the whole filter runs in the database
   * with no join and no post-filtering. Text fields use case-insensitive
   * contains; phone matching is digit-only against the E.164 column, so a
   * substring match works whether or not the caller typed the '+' — the same
   * rules as the orders and users consoles.
   */
  private buildSearch(
    raw?: string,
  ): Prisma.CatalogSellerWhereInput[] | undefined {
    const term = raw?.trim();
    if (!term) return undefined;

    const or: Prisma.CatalogSellerWhereInput[] = [
      { name: { contains: term, mode: 'insensitive' } },
      { city: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
    ];

    const digits = term.replace(/\D/g, '');
    if (digits.length >= MIN_PHONE_SEARCH_DIGITS) {
      or.push({ phoneE164: { contains: digits } });
    }

    return or;
  }
}

/** Legal next states, keyed by the current one. */
const ALLOWED_TRANSITIONS: Record<DealerStatus, DealerStatus[]> = {
  [DealerStatus.PENDING]: [DealerStatus.ACTIVE],
  [DealerStatus.ACTIVE]: [DealerStatus.SUSPENDED],
  [DealerStatus.SUSPENDED]: [DealerStatus.ACTIVE],
};

/**
 * Audit verb for a transition, keyed by BOTH ends. The destination alone is not
 * enough: PENDING → ACTIVE is an approval while SUSPENDED → ACTIVE is a
 * reactivation, and the trail has to tell them apart. Only the legal
 * transitions appear here — assertTransition has already rejected the rest.
 */
function auditActionFor(
  from: DealerStatus,
  to: DealerStatus,
): AdminAuditAction {
  if (to === DealerStatus.SUSPENDED) return AdminAuditAction.DEALER_SUSPENDED;
  return from === DealerStatus.SUSPENDED
    ? AdminAuditAction.DEALER_REACTIVATED
    : AdminAuditAction.DEALER_APPROVED;
}

/**
 * Lowercase ASCII hyphen-slug for a new dealer id, e.g. "BYD Motors" → "byd-
 * motors". Capped short so the numeric-suffix uniqueness step still fits inside
 * the 64-char id column. Empty result (all-symbol names) falls back in the
 * caller to "dealer".
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
}
