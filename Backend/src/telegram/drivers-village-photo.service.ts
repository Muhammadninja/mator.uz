/**
 * Driver's Village photo updates from Telegram — the DATABASE side.
 *
 * A Telegram user sends 1–10 photos with the caption = a position's code_1c.
 * The bot runs those photos through the ordinary image pipeline (draft → BullMQ
 * worker → preview) and, on confirm, replaces the gallery of the EXISTING
 * product behind that position. Nothing is ever created: no Product, no Stock.
 *
 * Identity rule: a position is found ONLY by its Driver's Village Stock source
 * fields — (seller = the Driver's Village BUSINESS seller, source_system =
 * DRIVERS_VILLAGE_1C, source_code = code_1c). Never by gmNumber, never by any
 * part number, so a Telegram seller's listing with the same GM/OEM value can
 * never be reached from here, and code_1c is never written anywhere.
 *
 * Orchestration (messages, queue, confirm/cancel buttons) stays in
 * TelegramService next to the ordinary flow it reuses; this class only reads and
 * writes rows.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, SellerType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
 * The shape of a 1C position code: a short Latin/Cyrillic/digit prefix, a dash,
 * digits — `00-00001431`, `БП-01068170`. Only a caption of this shape starts a
 * Driver's Village update; any other caption (or none) leaves the photos to the
 * ordinary listing wizard exactly as before.
 */
const CODE_1C_SHAPE = /^[0-9A-ZА-ЯЁ]{1,6}-\d{5,12}$/u;
/** Dash look-alikes a phone keyboard may substitute for '-'. */
const DASH_LOOKALIKES = /[‐-―−]/g;

/**
 * The code_1c a caption names, normalized (NFKC, dash look-alikes → '-', trimmed,
 * uppercase), or null when the caption is not a single code. Matching against
 * the stock is then EXACT — no fuzzy lookup.
 */
export function code1cFromCaption(
  caption: string | null | undefined,
): string | null {
  if (!caption) return null;
  const value = caption
    .normalize('NFKC')
    .replace(DASH_LOOKALIKES, '-')
    .trim()
    .toUpperCase();
  return CODE_1C_SHAPE.test(value) ? value : null;
}

/** Escape Telegram legacy-Markdown control characters in a dynamic value. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([_*`[])/g, '\\$1');
}

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class DriversVillagePhotoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: ProductDraftService,
  ) {}

  /**
   * Find the position a caption's code_1c names. Read-only: an unknown code (or
   * a database without the Driver's Village seller) returns null and nothing is
   * written anywhere.
   */
  async resolvePosition(code1c: string): Promise<DvPosition | null> {
    return this.findPosition(this.prisma, { code1c });
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
    return this.findPosition(this.prisma, { stockId });
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
      const position = await this.findPosition(tx, { stockId });
      if (!position) return null;
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

  /**
   * The single identity check: the stock must belong to the Driver's Village
   * BUSINESS seller and carry the DRIVERS_VILLAGE_1C source. Looked up by
   * code_1c (new upload) or by stock id (confirm), and verified either way.
   */
  private async findPosition(
    db: Db,
    by: { code1c: string } | { stockId: number },
  ): Promise<DvPosition | null> {
    const seller = await db.seller.findUnique({
      where: { catalogSellerId: DRIVERS_VILLAGE_CATALOG_SELLER_ID },
      select: { id: true, sellerType: true },
    });
    if (!seller || seller.sellerType !== SellerType.BUSINESS) return null;

    const select = {
      id: true,
      sellerId: true,
      sourceSystem: true,
      sourceCode: true,
      productId: true,
      product: {
        select: { title: true, _count: { select: { images: true } } },
      },
    } satisfies Prisma.StockSelect;
    const stock =
      'code1c' in by
        ? await db.stock.findUnique({
            where: {
              sellerId_sourceSystem_sourceCode: {
                sellerId: seller.id,
                sourceSystem: DRIVERS_VILLAGE_SOURCE_SYSTEM,
                sourceCode: by.code1c,
              },
            },
            select,
          })
        : await db.stock.findUnique({ where: { id: by.stockId }, select });

    if (
      !stock ||
      stock.sellerId !== seller.id ||
      stock.sourceSystem !== DRIVERS_VILLAGE_SOURCE_SYSTEM ||
      !stock.sourceCode
    ) {
      return null;
    }
    return {
      sellerId: seller.id,
      stockId: stock.id,
      productId: stock.productId,
      code1c: stock.sourceCode,
      title: stock.product.title,
      imageCount: stock.product._count.images,
    };
  }
}
