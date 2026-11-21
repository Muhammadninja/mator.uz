import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AdminAuditAction, AdminAuditEntity, Prisma } from '@prisma/client';
import { CatalogProjectionService } from '../../catalog/projection/catalog-projection.service';
import {
  CloudinaryService,
  type UploadedImage,
} from '../../cloudinary/cloudinary.service';
import {
  ALLOWED_IMAGE_MIME,
  CloudinaryFolder,
  MAX_PRODUCT_PHOTO_BYTES,
} from '../../common/image.constants';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminAuditActor,
} from '../auth/admin-audit.service';
import {
  displayablePhotos,
  isDisplayablePhotoUrl,
  stockIdOfPartId,
} from './photo-coverage.rules';

/** Photos one part can hold: the Telegram listing flow's limit, 1–10. */
export const MAX_PART_PHOTOS = 10;

/** One uploaded file as multer hands it over. */
export interface PartPhotoFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Who is editing, for the audit entry. */
export interface PartPhotosContext {
  actor: AdminAuditActor;
  ip?: string | null;
  userAgent?: string | null;
}

export type PartPhotosOperation = 'append' | 'replace' | 'remove' | 'clear';

/**
 * Where a part's gallery is stored:
 *   • product — a part projected from a Stock row (`part_stock_<id>`). The
 *     photos belong to the supply-side Product (`product_images`), which every
 *     stock of that product projects into its own catalog part. The edit lands
 *     there and is then re-projected, exactly as a Telegram photo update is.
 *   • part — a part with no Stock behind it (seeded). Nothing projects into it,
 *     so its own `catalog_parts.images` is the gallery.
 */
type GallerySource =
  { kind: 'product'; productId: number; stockId: number } | { kind: 'part' };

interface ResolvedPart {
  partId: string;
  title: string;
  source: GallerySource;
}

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Version of an ordered gallery: the first 32 hex characters of the SHA-256 of
 * its URLs. The screen sends back the version it showed, so an edit made from
 * a stale screen is refused instead of deleting or replacing the wrong photo.
 */
export function galleryVersion(urls: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(urls))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Photo editing for the photo-coverage console ("Контроль фотографий"): upload
 * new photos, replace one, delete one, delete all.
 *
 * Every change runs in one transaction that locks the gallery's owner row (the
 * same `products` row lock the Driver's Village photo update takes), re-reads
 * the gallery, checks the version the operator saw, writes the new ordered list
 * and records an audit entry with the URLs before and after.
 *
 * A removed photo is only unlinked: its Cloudinary asset is NOT deleted. Cart
 * lines keep `images[0]` as it was when the item was added, and the audit entry
 * is enough to put a photo back. Only an upload this request made and could
 * not save is deleted again.
 */
@Injectable()
export class AdminPartPhotosService {
  private readonly logger = new Logger(AdminPartPhotosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    private readonly projection: CatalogProjectionService,
    private readonly audit: AdminAuditService,
  ) {}

  /** The part's gallery as the editor shows it. */
  async gallery(partId: string) {
    return { success: true, data: await this.view(await this.resolve(partId)) };
  }

  /** Add photos after the existing ones. On a part with none, the first becomes the main photo. */
  async append(
    partId: string,
    version: string,
    files: PartPhotoFile[] | undefined,
    ctx: PartPhotosContext,
  ) {
    const photos = this.checkFiles(files, MAX_PART_PHOTOS);
    return this.mutate(
      partId,
      version,
      ctx,
      'append',
      photos,
      (urls, added) => {
        if (urls.length + added.length > MAX_PART_PHOTOS) {
          throw new BadRequestException({
            code: 'TOO_MANY_PHOTOS',
            message: `A part holds at most ${MAX_PART_PHOTOS} photos; it has ${urls.length}.`,
          });
        }
        return [...urls, ...added];
      },
    );
  }

  /** Put a new photo in place of the one at `index`, keeping its position. */
  async replace(
    partId: string,
    index: number,
    version: string,
    file: PartPhotoFile | undefined,
    ctx: PartPhotosContext,
  ) {
    const photos = this.checkFiles(file ? [file] : [], 1);
    return this.mutate(
      partId,
      version,
      ctx,
      'replace',
      photos,
      (urls, [url]) => {
        this.checkIndex(urls, index);
        return urls.map((u, i) => (i === index ? url : u));
      },
    );
  }

  /** Remove the photo at `index`; the ones after it move up. */
  async remove(
    partId: string,
    index: number,
    version: string,
    ctx: PartPhotosContext,
  ) {
    return this.mutate(partId, version, ctx, 'remove', [], (urls) => {
      this.checkIndex(urls, index);
      return urls.filter((_, i) => i !== index);
    });
  }

  /** Remove every photo. The part then has none and buyer lists leave it out. */
  async clear(partId: string, version: string, ctx: PartPhotosContext) {
    return this.mutate(partId, version, ctx, 'clear', [], (urls) => {
      if (urls.length === 0) {
        throw new BadRequestException({
          code: 'NO_PHOTOS',
          message: 'The part has no photos to delete.',
        });
      }
      return [];
    });
  }

  // ── the one write path ─────────────────────────────────────────────────────

  private async mutate(
    partId: string,
    version: string,
    ctx: PartPhotosContext,
    operation: PartPhotosOperation,
    files: PartPhotoFile[],
    edit: (urls: string[], added: string[]) => string[],
  ) {
    const part = await this.resolve(partId);

    // Refuse a stale screen or an impossible edit BEFORE anything is uploaded.
    // The check that counts runs again below, under the lock.
    const seen = await this.readUrls(this.prisma, part);
    this.checkVersion(seen, version);
    edit(
      seen,
      files.map(() => ''),
    );

    const uploaded = await this.upload(files);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, part);
        const before = await this.readUrls(tx, part);
        this.checkVersion(before, version);
        const after = edit(
          before,
          uploaded.map((u) => u.url),
        );
        await this.write(tx, part, after);
        await this.audit.record(
          {
            action: AdminAuditAction.CATALOG_PART_PHOTOS_UPDATED,
            actor: ctx.actor,
            target: {
              entity: AdminAuditEntity.CATALOG_PART,
              id: part.partId,
              name: part.title,
            },
            previousValues: { photos: before },
            newValues: {
              operation,
              photos: after,
              ...(part.source.kind === 'product'
                ? { productId: part.source.productId }
                : {}),
            },
            ip: ctx.ip ?? null,
            userAgent: ctx.userAgent ?? null,
          },
          tx,
        );
      });
    } catch (err) {
      // Nothing was saved, so this request's uploads would only be orphans.
      await this.cloudinary.deleteAssets(uploaded.map((u) => u.publicId));
      throw err;
    }

    if (part.source.kind === 'product') {
      await this.reproject(part.source.productId);
    }
    return { success: true, data: await this.view(part) };
  }

  // ── reading ────────────────────────────────────────────────────────────────

  private async resolve(partId: string): Promise<ResolvedPart> {
    const row = await this.prisma.catalogPart.findUnique({
      where: { id: partId },
      select: { id: true, title: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'PART_NOT_FOUND',
        message: `No catalog part ${partId}.`,
      });
    }
    const stockId = stockIdOfPartId(partId);
    const stock =
      stockId === null
        ? null
        : await this.prisma.stock.findUnique({
            where: { id: stockId },
            select: { id: true, productId: true },
          });
    return {
      partId: row.id,
      title: row.title,
      source: stock
        ? { kind: 'product', productId: stock.productId, stockId: stock.id }
        : { kind: 'part' },
    };
  }

  /** The gallery in its stored order. */
  private async readUrls(db: Db, part: ResolvedPart): Promise<string[]> {
    if (part.source.kind === 'product') {
      const rows = await db.productImage.findMany({
        where: { productId: part.source.productId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { url: true },
      });
      return rows.map((r) => r.url);
    }
    const row = await db.catalogPart.findUnique({
      where: { id: part.partId },
      select: { images: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'PART_NOT_FOUND',
        message: `No catalog part ${part.partId}.`,
      });
    }
    return row.images;
  }

  private async view(part: ResolvedPart) {
    const { source } = part;
    const [urls, shown, others] = await Promise.all([
      this.readUrls(this.prisma, part),
      this.prisma.catalogPart.findUnique({
        where: { id: part.partId },
        select: { images: true },
      }),
      source.kind === 'product'
        ? this.prisma.stock.findMany({
            where: { productId: source.productId, NOT: { id: source.stockId } },
            select: { id: true },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([] as { id: number }[]),
    ]);
    // What the buyer catalog should hold once the projection has run: it keeps
    // only displayable product photos. A seeded part's gallery IS that column.
    const expected = source.kind === 'product' ? displayablePhotos(urls) : urls;
    const actual = shown?.images ?? [];
    return {
      partId: part.partId,
      title: part.title,
      source: source.kind,
      productId: source.kind === 'product' ? source.productId : null,
      // Other catalog parts that show this same gallery (the product's other
      // stocks): an edit here changes them too.
      sharedPartIds: others.map((s) =>
        CatalogProjectionService.catalogPartId(s.id),
      ),
      version: galleryVersion(urls),
      maxPhotos: MAX_PART_PHOTOS,
      photos: urls.map((url, index) => ({
        index,
        url,
        displayable: isDisplayablePhotoUrl(url),
      })),
      // False only when a re-projection failed after a saved edit: the buyer
      // still sees the old photos until the next projection of this product.
      catalogSynced:
        expected.length === actual.length &&
        expected.every((url, i) => url === actual[i]),
    };
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /** Serialize edits of one gallery (and the Driver's Village photo update). */
  private async lock(tx: Prisma.TransactionClient, part: ResolvedPart) {
    const rows =
      part.source.kind === 'product'
        ? await tx.$queryRaw<
            { id: number }[]
          >`SELECT id FROM products WHERE id = ${part.source.productId} FOR UPDATE`
        : await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM catalog_parts WHERE id = ${part.partId} FOR UPDATE`;
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'PART_NOT_FOUND',
        message: `No catalog part ${part.partId}.`,
      });
    }
  }

  private async write(
    tx: Prisma.TransactionClient,
    part: ResolvedPart,
    urls: string[],
  ) {
    if (part.source.kind === 'part') {
      await tx.catalogPart.update({
        where: { id: part.partId },
        data: { images: urls },
        select: { id: true },
      });
      return;
    }
    const { productId } = part.source;
    // The gallery replacement every other photo path performs: deleteMany +
    // createMany in order (first = primary), and Product.imageUrl mirrors the first.
    await tx.productImage.deleteMany({ where: { productId } });
    if (urls.length > 0) {
      await tx.productImage.createMany({
        data: urls.map((url, i) => ({
          productId,
          url,
          sortOrder: i,
          isPrimary: i === 0,
        })),
      });
    }
    await tx.product.update({
      where: { id: productId },
      data: { imageUrl: urls[0] ?? null },
      select: { id: true },
    });
  }

  /**
   * Push the saved gallery to every catalog part of the product. A photo is
   * neither a classification nor a price, so an operator's category move and
   * inventory edits of those parts survive it (as for a rating edit). A failure
   * is logged, not thrown: the edit is saved, and the response reports
   * `catalogSynced: false`.
   */
  private async reproject(productId: number) {
    try {
      await this.projection.projectProduct(productId, {
        keepClassification: true,
        keepPriceAndStock: true,
      });
    } catch (err) {
      this.logger.error(
        `Photos saved for product ${productId} but re-projection failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Upload every file, or none: a partial upload is deleted again. */
  private async upload(files: PartPhotoFile[]): Promise<UploadedImage[]> {
    if (files.length === 0) return [];
    const results = await Promise.allSettled(
      files.map((f) =>
        this.cloudinary.uploadBuffer(
          f.buffer,
          CloudinaryFolder.PRODUCTS,
          // A PNG may carry transparency; anything else is a photograph.
          f.mimetype === 'image/png' ? 'png' : 'jpg',
        ),
      ),
    );
    const done = results
      .filter(
        (r): r is PromiseFulfilledResult<UploadedImage> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value);
    if (done.length < files.length) {
      const reason: unknown = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      )?.reason;
      this.logger.error(
        `Part photo upload failed: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
      await this.cloudinary.deleteAssets(done.map((u) => u.publicId));
      throw new BadGatewayException({
        code: 'PHOTO_UPLOAD_FAILED',
        message: 'The photo could not be uploaded. Try again.',
      });
    }
    return done;
  }

  // ── checks ─────────────────────────────────────────────────────────────────

  private checkFiles(
    files: PartPhotoFile[] | undefined,
    max: number,
  ): PartPhotoFile[] {
    const list = (files ?? []).filter((f) => f?.buffer?.length);
    if (list.length === 0) {
      throw new BadRequestException({
        code: 'PHOTO_REQUIRED',
        message: 'Attach a photo.',
      });
    }
    if (list.length > max) {
      throw new BadRequestException({
        code: 'TOO_MANY_PHOTOS',
        message: `At most ${max} photo(s) per request.`,
      });
    }
    for (const f of list) {
      if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(f.mimetype)) {
        throw new UnsupportedMediaTypeException({
          code: 'UNSUPPORTED_IMAGE_TYPE',
          message: 'Unsupported image type. Allowed: JPEG, PNG, WebP.',
        });
      }
      if (f.size > MAX_PRODUCT_PHOTO_BYTES) {
        throw new PayloadTooLargeException({
          code: 'PHOTO_TOO_LARGE',
          message: 'A photo exceeds the 10 MB size limit.',
        });
      }
    }
    return list;
  }

  private checkVersion(urls: readonly string[], version: string) {
    if (galleryVersion(urls) !== version) {
      throw new ConflictException({
        code: 'PHOTOS_CHANGED',
        message:
          "The part's photos changed since they were loaded. Reload and try again.",
      });
    }
  }

  private checkIndex(urls: readonly string[], index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= urls.length) {
      throw new NotFoundException({
        code: 'PHOTO_NOT_FOUND',
        message: `The part has no photo #${index}.`,
      });
    }
  }
}
