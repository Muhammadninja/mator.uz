import { Injectable, Logger } from '@nestjs/common';
import { ProductKind } from '@prisma/client';
import type Anthropic from '@anthropic-ai/sdk';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PartsService } from '../catalog/parts/parts.service';
import { CategoriesService } from '../catalog/categories/categories.service';
import {
  AppLang,
  DEFAULT_APP_LANG,
} from '../common/app-lang.util';
import { ListPartsQueryDto } from '../catalog/parts/dto/list-parts.query.dto';

/**
 * The catalog tools the model may call, and the ONLY way a catalog fact reaches
 * a reply.
 *
 * ── Why tools at all ────────────────────────────────────────────────────────
 * The model is allowed to interpret intent ("my brakes squeal on a 2019 Cobalt")
 * but is never the source of a price, a stock flag, a seller or a compatibility
 * verdict. Every such fact is fetched here, through the SAME services that serve
 * GET /v1/catalog/parts, so an answer in chat and the catalogue screen cannot
 * disagree: sale pricing, discount resolution, fitment and the motor-oil rules
 * are all applied by {@link PartsService}, not re-implemented.
 *
 * ── Why not Prisma directly ─────────────────────────────────────────────────
 * Querying Prisma here would fork the pricing rules (a chat reply would quote
 * pre-sale prices the moment a campaign went live) and would put query
 * construction next to model-controlled input. The model never supplies a
 * where-clause: it fills a narrow, validated DTO and the service builds the
 * query. There is no path from a tool argument to raw SQL or to a Prisma filter
 * object.
 */

/** Hard ceiling on rows returned to the model, whatever it asks for. */
const MAX_TOOL_RESULTS = 8;

/** Ceiling on tool round-trips per user turn — bounds cost and stops loops. */
export const MAX_TOOL_ROUNDS = 4;

/**
 * Tool definitions advertised to the provider. Kept deliberately narrow: each
 * input maps onto a field the buyer catalogue already exposes as a query param,
 * so the model can express a real buyer query and nothing more.
 */
export const CATALOG_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_catalog',
    description:
      'Search the Mator parts catalogue. Use this for ANY question about which parts exist, what they cost, whether they are in stock, or which dealer sells them. Never state a price, stock status or seller that did not come from this tool.',
    input_schema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'Free-text search over the part title.',
        },
        category: {
          type: 'string',
          description:
            "Category id/slug from get_categories (e.g. 'brakes'), or a main-category enum value.",
        },
        make: {
          type: 'string',
          description: "Vehicle make, e.g. 'Chevrolet'.",
        },
        model: { type: 'string', description: "Vehicle model, e.g. 'Cobalt'." },
        vehicle_id: {
          type: 'string',
          description:
            "The session's garage vehicle id. Pass it to restrict results to parts that fit that car.",
        },
        sort: {
          type: 'string',
          enum: ['price_asc', 'price_desc', 'rating_desc', 'popular'],
          description: 'Result ordering.',
        },
        page_size: {
          type: 'integer',
          description: `Rows to return (max ${MAX_TOOL_RESULTS}).`,
        },
      },
      required: [],
    },
  },
  {
    name: 'get_categories',
    description:
      'List the Mator part categories with live per-category inventory counts. Use before search_catalog when the user names a system ("brakes", "suspension") and you need its category id.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['main', 'vehicle'],
          description:
            "'main' for the part-system grid, 'vehicle' for vehicle categories.",
        },
        vehicle_id: {
          type: 'string',
          description:
            "The session's garage vehicle id, to scope counts to that car.",
        },
      },
      required: [],
    },
  },
  {
    name: 'get_product',
    description:
      'Fetch one catalogue part by id, with its authoritative price, stock, seller and compatibility. Use when the user asks about a specific part returned by search_catalog.',
    input_schema: {
      type: 'object',
      properties: {
        part_id: {
          type: 'string',
          description: 'The part id, as returned by search_catalog.',
        },
        vehicle_id: {
          type: 'string',
          description:
            "The session's garage vehicle id, to resolve compatibility.",
        },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'find_motor_oil',
    description:
      'Find motor oil. Motor oil is NOT selected through the spare-part vehicle-fitment flow — it is chosen by viscosity, oil type and volume. Use THIS tool, never search_catalog, for any oil question.',
    input_schema: {
      type: 'object',
      properties: {
        viscosity: {
          type: 'string',
          description:
            "SAE grade, exactly as written on the bottle, e.g. '5W-30'.",
        },
        oil_type: {
          type: 'string',
          enum: ['synthetic', 'semi_synthetic', 'mineral'],
          description: 'Oil type.',
        },
        volume_ml: {
          type: 'integer',
          description:
            'Package volume in millilitres, e.g. 4000 for a 4-litre can.',
        },
        page_size: {
          type: 'integer',
          description: `Rows to return (max ${MAX_TOOL_RESULTS}).`,
        },
      },
      required: [],
    },
  },
];

/** A tool result, plus whether it carried any catalogue rows. */
export interface ToolRunResult {
  content: string;
  itemCount: number;
}

/**
 * The subset of a presented catalogue part these tools read.
 *
 * Structurally compatible with `presentPartItem`'s output rather than derived
 * from it with ReturnType: the presenter's shape is wide and evolving, and only
 * these fields may ever be shown to the model. Naming them here means adding a
 * field to the presenter does NOT silently widen what the model can see.
 */
interface PresentedPart {
  id: string;
  title: string;
  kind: ProductKind;
  brand: { name: string } | null;
  price_uzs: number;
  price_label: string;
  original_price_uzs: number | null;
  in_stock: boolean;
  rating_avg: number | null;
  compatibility: { status: string } | null;
  seller: { name: string; certified: boolean };
  motor_oil: {
    viscosity: string | null;
    oil_type_label: string | null;
    volume_label: string | null;
  } | null;
  oem_numbers?: string[];
  delivery_eta_days_min?: number | null;
  delivery_eta_days_max?: number | null;
}

@Injectable()
export class CatalogToolsService {
  private readonly logger = new Logger(CatalogToolsService.name);

  constructor(
    private readonly parts: PartsService,
    private readonly categories: CategoriesService,
  ) {}

  /**
   * Execute one model-requested tool call.
   *
   * Every failure is converted into a STRING result rather than being thrown: a
   * rejected tool call must let the model recover in-conversation ("I couldn't
   * find that part"), not abort the user's turn. Unknown tool names land here
   * too, so a model that hallucinates a tool gets a corrective answer instead of
   * a 500.
   */
  async run(
    name: string,
    rawInput: unknown,
    lang: AppLang = DEFAULT_APP_LANG,
  ): Promise<ToolRunResult> {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'search_catalog':
          return await this.searchCatalog(input);
        case 'get_categories':
          return await this.getCategories(input, lang);
        case 'get_product':
          return await this.getProduct(input);
        case 'find_motor_oil':
          return await this.findMotorOil(input);
        default:
          return this.error(`Unknown tool "${name}".`);
      }
    } catch (err) {
      // Log the tool and reason only — never the arguments, which carry the
      // user's own words.
      this.logger.warn(
        `Catalog tool "${name}" failed: ${(err as Error).message}`,
      );
      return this.error('The catalogue could not be reached for this request.');
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────────

  private async searchCatalog(
    input: Record<string, unknown>,
  ): Promise<ToolRunResult> {
    const query = this.toPartsQuery({
      q: input.q,
      category: input.category,
      make: input.make,
      model: input.model,
      vehicle_id: input.vehicle_id,
      sort: input.sort,
      page_size: this.pageSize(input.page_size),
    });
    const result = await this.parts.list(query);
    // The presenter returns a wider row than the model may see; narrowing to
    // PresentedPart here is what makes the allowlist in slimPart the boundary.
    return this.present(
      (result.items as PresentedPart[]).map((i) => this.slimPart(i)),
      result.total,
    );
  }

  private async findMotorOil(
    input: Record<string, unknown>,
  ): Promise<ToolRunResult> {
    // `kind: ['motor_oil']` is asserted here rather than left to the caller, so
    // this tool can only ever return oils. The oil attributes then flow through
    // PartsService.kindWhere — the same rules the buyer filter chips use — so the
    // oil-selection logic is reused, not restated for the model.
    const query = this.toPartsQuery({
      kind: ['motor_oil'],
      viscosity: input.viscosity !== undefined ? [input.viscosity] : undefined,
      oil_type: input.oil_type !== undefined ? [input.oil_type] : undefined,
      volume_ml:
        input.volume_ml !== undefined ? [Number(input.volume_ml)] : undefined,
      page_size: this.pageSize(input.page_size),
    });
    const result = await this.parts.list(query);
    return this.present(
      (result.items as PresentedPart[]).map((i) => this.slimOil(i)),
      result.total,
    );
  }

  /**
   * The category list the model reasons over. Names are given in the SESSION's
   * language so the model can echo a category back to the user in the words
   * they will see in the app; `id` stays the stable identifier it must pass to
   * `search_catalog`.
   */
  private async getCategories(
    input: Record<string, unknown>,
    lang: AppLang,
  ): Promise<ToolRunResult> {
    const scope = input.scope === 'vehicle' ? 'vehicle' : 'main';
    const vehicleId =
      typeof input.vehicle_id === 'string' ? input.vehicle_id : undefined;
    const result = await this.categories.list(
      {
        scope,
        vehicle_id: vehicleId,
      } as never,
      lang,
    );
    const items = result.items.map(
      (c: { id: string; label: string; count: number }) => ({
        id: c.id,
        // The localized label, NOT the internal `name` the model used to get.
        name: c.label,
        part_count: c.count,
      }),
    );
    return this.present(items, result.total);
  }

  private async getProduct(
    input: Record<string, unknown>,
  ): Promise<ToolRunResult> {
    const partId =
      typeof input.part_id === 'string' ? input.part_id.trim() : '';
    if (!partId) return this.error('part_id is required.');
    const vehicleId =
      typeof input.vehicle_id === 'string' ? input.vehicle_id : undefined;
    try {
      const part = await this.parts.detail(partId, vehicleId);
      return this.present([this.detailPart(part)], 1);
    } catch {
      // A NotFoundException is an ANSWER ("no such part"), not a failure.
      return this.error(`No catalogue part with id "${partId}".`);
    }
  }

  // ── shaping ────────────────────────────────────────────────────────────────

  /**
   * Build a validated {@link ListPartsQueryDto} from model-supplied values.
   *
   * The DTO is run through the same class-validator pipeline the HTTP layer
   * uses, so a tool argument is subject to exactly the constraints a client
   * request would be. Unknown/invalid fields are dropped rather than rejected:
   * a slightly-off tool call should degrade to a broader search, not fail the
   * user's turn.
   */
  private toPartsQuery(raw: Record<string, unknown>): ListPartsQueryDto {
    const defined = Object.fromEntries(
      Object.entries(raw).filter(
        ([, v]) => v !== undefined && v !== null && v !== '',
      ),
    );
    const dto = plainToInstance(ListPartsQueryDto, defined, {
      enableImplicitConversion: true,
      excludeExtraneousValues: false,
    });
    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: false,
      skipMissingProperties: true,
    });
    for (const e of errors) {
      delete (dto as unknown as Record<string, unknown>)[e.property];
    }
    return dto;
  }

  /** Clamp a model-requested page size into [1, MAX_TOOL_RESULTS]. */
  private pageSize(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return MAX_TOOL_RESULTS;
    return Math.min(Math.floor(n), MAX_TOOL_RESULTS);
  }

  /**
   * The fields of a part the model may see. A deliberate allowlist, not the full
   * presenter output: the model needs enough to answer and cite, and nothing
   * more. Internal ids, purchase cost, margins and stock counts stay out.
   */
  private slimPart(item: PresentedPart) {
    return {
      part_id: item.id,
      title: item.title,
      brand: item.brand?.name ?? null,
      price_uzs: item.price_uzs,
      price_label: item.price_label,
      // Present only when a campaign actually applies, so the model can say "was
      // X, now Y" without inventing a discount.
      original_price_uzs: item.original_price_uzs ?? null,
      in_stock: item.in_stock,
      seller: item.seller?.name ?? null,
      seller_certified: item.seller?.certified ?? false,
      rating_avg: item.rating_avg ?? null,
      compatibility: item.compatibility?.status ?? null,
    };
  }

  /** A motor oil's row: the oil attributes replace fitment, which oils lack. */
  private slimOil(item: PresentedPart) {
    const oil = item.motor_oil;
    return {
      ...this.slimPart(item),
      compatibility: undefined,
      viscosity: oil?.viscosity ?? null,
      oil_type: oil?.oil_type_label ?? null,
      volume: oil?.volume_label ?? null,
    };
  }

  /** A single part's detail view — the list shape plus part numbers and ETA. */
  private detailPart(item: PresentedPart) {
    const kindIsOil = item.kind === ProductKind.MOTOR_OIL;
    return {
      ...(kindIsOil ? this.slimOil(item) : this.slimPart(item)),
      oem_numbers: item.oem_numbers ?? [],
      delivery_eta_days_min: item.delivery_eta_days_min ?? null,
      delivery_eta_days_max: item.delivery_eta_days_max ?? null,
    };
  }

  /**
   * Serialize a tool result for the model. `total` is reported alongside the
   * returned rows so the model can say "12 matches, here are the cheapest 8"
   * rather than implying it saw everything.
   */
  private present(items: unknown[], total: number): ToolRunResult {
    return {
      content: JSON.stringify({ items, returned: items.length, total }),
      itemCount: items.length,
    };
  }

  private error(message: string): ToolRunResult {
    return {
      content: JSON.stringify({ error: message, items: [], total: 0 }),
      itemCount: 0,
    };
  }
}
