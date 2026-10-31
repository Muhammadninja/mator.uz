/**
 * Driver's Village photo updates from Telegram — the DATABASE side.
 *
 * A Telegram user sends 1–10 photos with the caption `1C <code_1c>` (or a
 * legacy 1C code alone, e.g. `00-00001431`). The bot runs those photos through
 * the ordinary image pipeline (draft → BullMQ worker → preview) and, on
 * confirm, replaces the gallery of the EXISTING product behind that position.
 * Nothing is ever created: no Product, no Stock.
 *
 * Identity rule: a position is found ONLY by its Driver's Village Stock source
 * fields — (seller = the Driver's Village BUSINESS seller, source_system =
 * DRIVERS_VILLAGE_1C, source_code = code_1c): the exact code first, then the
 * importer's own 8-digit key evidence. Never by gmNumber, never by any part
 * number, so a Telegram seller's listing with the same GM/OEM value can never
 * be reached from here, and code_1c is never written anywhere.
 *
 * Orchestration (messages, queue, confirm/cancel buttons) stays in
 * TelegramService next to the ordinary flow it reuses; this class only reads and
 * writes rows.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, SellerType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  code1cIssue,
  eightDigitKey,
  keyProvesSamePart,
} from '../imports/drivers-village/drivers-village-code-key';
import {
  DRIVERS_VILLAGE_CATALOG_SELLER_ID,
  DRIVERS_VILLAGE_SOURCE_SYSTEM,
} from '../imports/drivers-village/drivers-village.constants';
import {
  ProductDraftService,
  type DraftWithImages,
} from './product-draft.service';
import { WizardStep } from './product-wizard';

/** A resolved Driver's Village position. */
export interface DvPosition {
  sellerId: number;
  stockId: number;
  productId: number;
  code1c: string;
  title: string;
  /** Photos the product has right now (shown in the preview). */
  imageCount: number;
}

/**
 * How a caption's code_1c resolved. Nothing is written for any outcome:
 *   • found     — the one position the code names;
 *   • notFound  — no position;
 *   • ambiguous — the code's 8-digit key links it to several positions; the
 *                 sender is shown them to resend the exact code.
 */
export type DvLookup =
  | { kind: 'found'; position: DvPosition }
  | { kind: 'notFound' }
  | { kind: 'ambiguous'; positions: DvPosition[] };

/**
 * What a photo caption asks for:
 *   • none    — not a Driver's Village caption: the ordinary listing wizard;
 *   • code    — a photo update of the position with this code_1c;
 *   • invalid — the caption carries the `1C` marker but no valid code. It is
 *               refused, and NEVER handed to the listing wizard.
 */
export type DvCaption =
  { kind: 'none' } | { kind: 'code'; code1c: string } | { kind: 'invalid' };

/**
 * The explicit marker of a photo update: `1C` (Latin C or Cyrillic С, any
 * case), then a space or a colon — `1C 87654321`, `1С: 87654321`. Without the
 * separator `1C0919275` is a code of its own, not a marker.
 */
const MARKER = /^1[CcСс](?=$|[\s:])\s*:?\s*/u;
/**
 * The shape of a LEGACY 1C position code: a short Latin/Cyrillic/digit prefix,
 * a dash, digits — `00-00001431`, `БП-01068170`. Such a code still starts a
 * photo update on its own, without the marker, uppercased as it always was.
 */
const CODE_1C_SHAPE = /^[0-9A-ZА-ЯЁ]{1,6}-\d{5,12}$/u;
/** Dash look-alikes a phone keyboard may substitute for '-'. */
const DASH_LOOKALIKES = /[‐-―−]/g;
/** At most this many positions are listed for an ambiguous code. */
const MAX_LISTED_POSITIONS = 10;

/**
 * Read a photo caption (see DvCaption). It is normalized — NFKC, dash
 * look-alikes → '-', whitespace runs → one space, trimmed — and otherwise kept
 * as typed, because the importer stores code_1c verbatim: the code must pass
 * the importer's own rule (code1cIssue) and is then matched exactly. Only a
 * legacy-shaped code is uppercased, as before.
 */
export function parseDvCaption(caption: string | null | undefined): DvCaption {
  if (!caption) return { kind: 'none' };
  const value = caption
    .normalize('NFKC')
    .replace(DASH_LOOKALIKES, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const marker = MARKER.exec(value);
  const code = marker ? value.slice(marker[0].length) : value;
  const legacy = code.toUpperCase();
  if (CODE_1C_SHAPE.test(legacy)) return { kind: 'code', code1c: legacy };
  // Without the marker only a legacy code is a photo update: any other
  // caption (a GM number, a description) stays with the listing wizard.
  if (!marker) return { kind: 'none' };
  return code1cIssue(code) === null
    ? { kind: 'code', code1c: code }
    : { kind: 'invalid' };
}

/** Escape Telegram legacy-Markdown control characters in a dynamic value. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([_*`[])/g, '\\$1');
}

/**
 * A whole legacy-Markdown message as plain text: the formatting markers
 * (`*bold*`, `_italic_`, `` `code` ``) are dropped and what
 * {@link escapeMarkdown} escaped is unescaped. For resending a message Telegram
 * refused to parse — the words survive, only the emphasis is lost.
 */
export function markdownToPlainText(value: string): string {
  return value.replace(
    /\\([_*`[])|[_*`]/g,
    (_marker: string, escaped?: string) => escaped ?? '',
  );
}

/**
 * The positions an ambiguous code links to, one plain-text line each
 * (`• code — title`), capped so the answer stays one Telegram message.
 */
export function listPositions(positions: DvPosition[]): string {
  const lines = positions
    .slice(0, MAX_LISTED_POSITIONS)
    .map((p) => `• ${p.code1c} — ${p.title}`);
  if (positions.length > MAX_LISTED_POSITIONS) lines.push('…');
  return lines.join('\n');
}

type Db = PrismaService | Prisma.TransactionClient;

/** The Stock fields a position is built from (see toPosition). */
const POSITION_SELECT = {
  id: true,
  sellerId: true,
  sourceSystem: true,
  sourceCode: true,
  productId: true,
  product: {
    select: { title: true, _count: { select: { images: true } } },
  },
} satisfies Prisma.StockSelect;

type PositionStock = Prisma.StockGetPayload<{
  select: typeof POSITION_SELECT;
}>;

/**
 * The single identity check: the stock must belong to the Driver's Village
 * BUSINESS seller and carry the DRIVERS_VILLAGE_1C source with a code.
 */
function toPosition(
  sellerId: number,
  stock: PositionStock | null,
): DvPosition | null {
  if (
    !stock ||
    stock.sellerId !== sellerId ||
    stock.sourceSystem !== DRIVERS_VILLAGE_SOURCE_SYSTEM ||
    !stock.sourceCode
  ) {
    return null;
  }
  return {
    sellerId,
    stockId: stock.id,
    productId: stock.productId,
    code1c: stock.sourceCode,
    title: stock.product.title,
    imageCount: stock.product._count.images,
  };
}

@Injectable()
export class DriversVillagePhotoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: ProductDraftService,
  ) {}

  /**
   * Find the position a caption's code_1c names. Read-only. The exact code
   * always wins; only when no position has it does the importer's key evidence
   * apply (keyProvesSamePart): the bare article and the article with a marker
   * are one part, so `96273708` finds the position stored as `96273708 GMB`
   * and back. A database without the Driver's Village seller finds nothing.
   */
  async resolvePosition(code1c: string): Promise<DvLookup> {
    const seller = await this.dvSeller(this.prisma);
    if (!seller) return { kind: 'notFound' };
    const exact = toPosition(
      seller.id,
      await this.prisma.stock.findUnique({
        where: {
          sellerId_sourceSystem_sourceCode: {
            sellerId: seller.id,
            sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
            sourceCode: code1c,
          },
        },
        select: POSITION_SELECT,
      }),
    );
    if (exact) return { kind: 'found', position: exact };

    const key = eightDigitKey(code1c);
    if (!key) return { kind: 'notFound' };
    const stocks = await this.prisma.stock.findMany({
      where: {
        sellerId: seller.id,
        sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
        sourceCode: { contains: key },
      },
      select: POSITION_SELECT,
      orderBy: { sourceCode: 'asc' },
    });
    const linked = stocks
      .map((stock) => toPosition(seller.id, stock))
      .filter(
        (p): p is DvPosition =>
          p !== null && keyProvesSamePart(code1c, p.code1c),
      );
    if (linked.length === 0) return { kind: 'notFound' };
    return linked.length === 1
      ? { kind: 'found', position: linked[0] }
      : { kind: 'ambiguous', positions: linked };
  }

  /**
   * Create the PHOTO-UPDATE draft: one PROCESSING image row per photo, targeting
   * the position's stock. Owned by the Driver's Village seller (the listing's
   * seller); `tgId` is the sender's chat, where the preview goes.
   */
  createPhotoDraft(params: {
    position: DvPosition;
    tgUserId: number;
    fileIds: string[];
    expiresAt: Date;
  }): Promise<DraftWithImages> {
    return this.drafts.createWithImages({
      sellerId: params.position.sellerId,
      tgId: BigInt(params.tgUserId),
      // There is no questionnaire: the draft starts "form-done".
      formStep: WizardStep.QUESTIONNAIRE_DONE,
      expiresAt: params.expiresAt,
      images: params.fileIds.map((tgFileId, i) => ({ sortOrder: i, tgFileId })),
      targetStockId: params.position.stockId,
    });
  }

  /** Re-resolve a photo-update draft's target, re-checking its identity. */
  describeTarget(stockId: number): Promise<DvPosition | null> {
    return this.findPosition(this.prisma, stockId);
  }

  /**
   * Replace the product gallery of a Driver's Village position with `urls`, in
   * one transaction: the ordered rows are recreated (first = primary) and
   * Product.imageUrl mirrors the first. NOTHING else on the product or stock is
   * written — no title, number, fitment, category, price, quantity or source
   * field. Returns null (and writes nothing) when the stock is no longer a
   * Driver's Village position.
   */
  async replaceGallery(
    stockId: number,
    urls: string[],
  ): Promise<DvPosition | null> {
    if (urls.length === 0) {
      throw new Error('Refusing to replace a gallery with no images');
    }
    return this.prisma.$transaction(async (tx) => {
      const position = await this.findPosition(tx, stockId);
      if (!position) return null;
      // Confirms of one product run one at a time: a second confirm waits here
      // until the first commits, then replaces THAT gallery. Without the lock
      // two concurrent replacements could each keep their own rows (READ
      // COMMITTED), leaving a merged gallery with two primary photos.
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${position.productId} FOR UPDATE`;
      // The same gallery replacement the ordinary confirm path performs:
      // deleteMany + createMany, never an in-place URL rewrite.
      await tx.productImage.deleteMany({
        where: { productId: position.productId },
      });
      await tx.productImage.createMany({
        data: urls.map((url, i) => ({
          productId: position.productId,
          url,
          sortOrder: i,
          isPrimary: i === 0,
        })),
      });
      await tx.product.update({
        where: { id: position.productId },
        data: { imageUrl: urls[0] },
        select: { id: true },
      });
      return position;
    });
  }

  /** The Driver's Village BUSINESS seller, or null when there is none. */
  private async dvSeller(db: Db): Promise<{ id: number } | null> {
    const seller = await db.seller.findUnique({
      where: { catalogSellerId: DRIVERS_VILLAGE_CATALOG_SELLER_ID },
      select: { id: true, sellerType: true },
    });
    return seller?.sellerType === SellerType.BUSINESS ? seller : null;
  }

  /** A photo-update target by stock id, through the single identity check. */
  private async findPosition(
    db: Db,
    stockId: number,
  ): Promise<DvPosition | null> {
    const seller = await this.dvSeller(db);
    if (!seller) return null;
    return toPosition(
      seller.id,
      await db.stock.findUnique({
        where: { id: stockId },
        select: POSITION_SELECT,
      }),
    );
  }
}
