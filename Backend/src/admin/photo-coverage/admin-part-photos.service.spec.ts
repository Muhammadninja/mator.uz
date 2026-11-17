// AdminPartPhotosService with Prisma, Cloudinary, the projection and the audit
// trail stubbed (no database, no network). Pins where each kind of part keeps
// its gallery, the order and primary flag written, the version check before and
// under the lock, the audit entry, the re-projection, and what is cleaned up
// when an edit does not save.

import 'reflect-metadata';
import { AdminAuditAction, AdminAuditEntity } from '@prisma/client';
import {
  AdminPartPhotosService,
  galleryVersion,
  MAX_PART_PHOTOS,
  type PartPhotoFile,
} from './admin-part-photos.service';
import { displayablePhotos } from './photo-coverage.rules';

const A =
  'https://res.cloudinary.com/mator/image/upload/v1/mator/products/a.png';
const B =
  'https://res.cloudinary.com/mator/image/upload/v1/mator/products/b.png';
const C =
  'https://res.cloudinary.com/mator/image/upload/v1/mator/products/c.png';
const BROKEN = 'http://old-host/photo.jpg';

const CTX = {
  actor: { id: 'adm_1', email: 'op@mator.uz', name: 'Operator' },
  ip: '10.0.0.1',
  userAgent: 'jest',
};

const jpeg = (size = 1000): PartPhotoFile => ({
  buffer: Buffer.alloc(size, 1),
  mimetype: 'image/jpeg',
  size,
});
const png = (): PartPhotoFile => ({
  buffer: Buffer.alloc(10, 1),
  mimetype: 'image/png',
  size: 10,
});

interface Setup {
  partId?: string;
  /** null: no Stock behind the part (seeded part). */
  stock?: { id: number; productId: number } | null;
  productImages?: string[];
  partImages?: string[];
  otherStockIds?: number[];
}

function setup(opts: Setup = {}) {
  const partId = opts.partId ?? 'part_stock_7';
  const stock =
    opts.stock === undefined ? { id: 7, productId: 70 } : opts.stock;
  const state = {
    product: [...(opts.productImages ?? [])],
    part: [...(opts.partImages ?? displayablePhotos(opts.productImages ?? []))],
    imageUrl: undefined as string | null | undefined,
  };

  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
    productImage: {
      findMany: jest.fn(async () => state.product.map((url) => ({ url }))),
      deleteMany: jest.fn(async () => {
        state.product = [];
      }),
      createMany: jest.fn(async ({ data }: { data: { url: string }[] }) => {
        state.product = data.map((d) => d.url);
      }),
    },
    catalogPart: {
      findUnique: jest.fn(
        async ({ select }: { select: Record<string, boolean> }) =>
          select.title
            ? { id: partId, title: 'Колодки тормозные' }
            : { images: state.part },
      ),
      update: jest.fn(async ({ data }: { data: { images: string[] } }) => {
        state.part = data.images;
      }),
    },
    product: {
      update: jest.fn(
        async ({ data }: { data: { imageUrl: string | null } }) => {
          state.imageUrl = data.imageUrl;
        },
      ),
    },
    stock: {
      findUnique: jest.fn(async () => stock),
      findMany: jest.fn(async () =>
        (opts.otherStockIds ?? []).map((id) => ({ id })),
      ),
    },
  };
  const prisma = {
    ...db,
    $transaction: jest.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  };

  let n = 0;
  const cloudinary = {
    uploadBuffer: jest.fn(
      async (_buf: Buffer, folder: string, format: string) => {
        n += 1;
        return {
          url: `https://res.cloudinary.com/mator/image/upload/v2/${folder}/new${n}.${format}`,
          publicId: `${folder}/new${n}`,
        };
      },
    ),
    deleteAssets: jest.fn().mockResolvedValue(undefined),
  };
  const projection = {
    // The real projection keeps only displayable product photos.
    projectProduct: jest.fn(async () => {
      state.part = displayablePhotos(state.product);
      return [partId];
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new AdminPartPhotosService(
    prisma as never,
    cloudinary as never,
    projection as never,
    audit as never,
  );
  return { service, prisma, db, cloudinary, projection, audit, state, partId };
}

const uploaded = (n: number, ext = 'jpg') =>
  `https://res.cloudinary.com/mator/image/upload/v2/mator/products/new${n}.${ext}`;

describe('AdminPartPhotosService.gallery', () => {
  it("shows a projected part's product photos in stored order, with the version and the sharing parts", async () => {
    const { service, db } = setup({
      productImages: [A, BROKEN, B],
      otherStockIds: [9, 12],
    });

    const { data } = await service.gallery('part_stock_7');

    expect(db.productImage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId: 70 },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(data).toEqual({
      partId: 'part_stock_7',
      title: 'Колодки тормозные',
      source: 'product',
      productId: 70,
      sharedPartIds: ['part_stock_9', 'part_stock_12'],
      version: galleryVersion([A, BROKEN, B]),
      maxPhotos: MAX_PART_PHOTOS,
      photos: [
        { index: 0, url: A, displayable: true },
        { index: 1, url: BROKEN, displayable: false },
        { index: 2, url: B, displayable: true },
      ],
      // The catalog holds the displayable ones, as the projection writes them.
      catalogSynced: true,
    });
  });

  it('reports a catalog that still shows other photos', async () => {
    const { service } = setup({ productImages: [A, B], partImages: [C] });
    const { data } = await service.gallery('part_stock_7');
    expect(data.catalogSynced).toBe(false);
  });

  it("uses a seeded part's own images when no Stock is behind it", async () => {
    const { service, db } = setup({
      partId: 'launch_brake_pads',
      stock: null,
      partImages: [A, B],
    });
    const { data } = await service.gallery('launch_brake_pads');
    expect(db.stock.findUnique).not.toHaveBeenCalled();
    expect(db.productImage.findMany).not.toHaveBeenCalled();
    expect(data.source).toBe('part');
    expect(data.productId).toBeNull();
    expect(data.photos.map((p) => p.url)).toEqual([A, B]);
  });

  it('treats part_stock_<id> whose stock is gone as the part’s own gallery', async () => {
    const { service } = setup({ stock: null, partImages: [A] });
    const { data } = await service.gallery('part_stock_7');
    expect(data.source).toBe('part');
  });

  it('404s an unknown part', async () => {
    const { service, db } = setup();
    db.catalogPart.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.gallery('nope')).rejects.toMatchObject({
      status: 404,
      response: { code: 'PART_NOT_FOUND' },
    });
  });
});

describe('AdminPartPhotosService.append', () => {
  it('uploads, appends in order under the product lock, audits, and re-projects', async () => {
    const { service, db, cloudinary, projection, audit, state, prisma } = setup(
      {
        productImages: [A],
      },
    );

    const { data } = await service.append(
      'part_stock_7',
      galleryVersion([A]),
      [jpeg(), png()],
      CTX,
    );

    // A JPEG is stored as JPEG; a PNG keeps PNG (transparency).
    expect(cloudinary.uploadBuffer.mock.calls.map((c) => c.slice(1))).toEqual([
      ['mator/products', 'jpg'],
      ['mator/products', 'png'],
    ]);
    const lock = db.$queryRaw.mock.calls[0];
    expect(lock[0].join('?')).toContain(
      'FROM products WHERE id = ? FOR UPDATE',
    );
    expect(lock[1]).toBe(70);

    expect(db.productImage.createMany).toHaveBeenCalledWith({
      data: [
        { productId: 70, url: A, sortOrder: 0, isPrimary: true },
        { productId: 70, url: uploaded(1), sortOrder: 1, isPrimary: false },
        {
          productId: 70,
          url: uploaded(2, 'png'),
          sortOrder: 2,
          isPrimary: false,
        },
      ],
    });
    expect(state.imageUrl).toBe(A);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry, tx] = audit.record.mock.calls[0];
    expect(tx).toBe(db); // inside the transaction
    expect(entry).toEqual({
      action: AdminAuditAction.CATALOG_PART_PHOTOS_UPDATED,
      actor: CTX.actor,
      target: {
        entity: AdminAuditEntity.CATALOG_PART,
        id: 'part_stock_7',
        name: 'Колодки тормозные',
      },
      previousValues: { photos: [A] },
      newValues: {
        operation: 'append',
        photos: [A, uploaded(1), uploaded(2, 'png')],
        productId: 70,
      },
      ip: CTX.ip,
      userAgent: CTX.userAgent,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(projection.projectProduct).toHaveBeenCalledWith(70, {
      keepClassification: true,
      keepPriceAndStock: true,
    });
    expect(data.version).toBe(
      galleryVersion([A, uploaded(1), uploaded(2, 'png')]),
    );
    expect(data.catalogSynced).toBe(true);
    expect(cloudinary.deleteAssets).not.toHaveBeenCalled();
  });

  it('gives a part without photos its main photo', async () => {
    const { service, state } = setup({ productImages: [] });
    await service.append('part_stock_7', galleryVersion([]), [jpeg()], CTX);
    expect(state.product).toEqual([uploaded(1)]);
    expect(state.imageUrl).toBe(uploaded(1));
  });

  it('refuses a stale version before uploading anything', async () => {
    const { service, cloudinary, prisma } = setup({ productImages: [A, B] });
    await expect(
      service.append('part_stock_7', galleryVersion([A]), [jpeg()], CTX),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PHOTOS_CHANGED' },
    });
    expect(cloudinary.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a gallery changed while uploading, writes nothing and deletes its uploads', async () => {
    const { service, db, cloudinary, audit, projection, state } = setup({
      productImages: [A],
    });
    // Someone else's edit lands between the first read and the locked one.
    cloudinary.uploadBuffer.mockImplementationOnce(async () => {
      state.product = [B];
      return { url: uploaded(1), publicId: 'mator/products/new1' };
    });

    await expect(
      service.append('part_stock_7', galleryVersion([A]), [jpeg()], CTX),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.productImage.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(projection.projectProduct).not.toHaveBeenCalled();
    expect(cloudinary.deleteAssets).toHaveBeenCalledWith([
      'mator/products/new1',
    ]);
    expect(state.product).toEqual([B]);
  });

  it(`refuses more than ${MAX_PART_PHOTOS} photos before uploading`, async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `${A}?${i}`);
    const { service, cloudinary } = setup({ productImages: nine });
    await expect(
      service.append(
        'part_stock_7',
        galleryVersion(nine),
        [jpeg(), jpeg()],
        CTX,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'TOO_MANY_PHOTOS' },
    });
    expect(cloudinary.uploadBuffer).not.toHaveBeenCalled();
  });

  it('refuses a request without a photo, an unsupported type and an oversized file', async () => {
    const { service } = setup({ productImages: [] });
    const v = galleryVersion([]);
    await expect(
      service.append('part_stock_7', v, [], CTX),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'PHOTO_REQUIRED' },
    });
    await expect(
      service.append(
        'part_stock_7',
        v,
        [{ ...jpeg(), mimetype: 'image/gif' }],
        CTX,
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      service.append(
        'part_stock_7',
        v,
        [{ ...jpeg(), size: 11 * 1024 * 1024 }],
        CTX,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('deletes the uploads that succeeded when another one fails, and writes nothing', async () => {
    const { service, cloudinary, prisma } = setup({ productImages: [] });
    cloudinary.uploadBuffer
      .mockResolvedValueOnce({
        url: uploaded(1),
        publicId: 'mator/products/new1',
      })
      .mockRejectedValueOnce(new Error('Cloudinary: timeout'));

    await expect(
      service.append('part_stock_7', galleryVersion([]), [jpeg(), jpeg()], CTX),
    ).rejects.toMatchObject({
      status: 502,
      response: { code: 'PHOTO_UPLOAD_FAILED' },
    });
    expect(cloudinary.deleteAssets).toHaveBeenCalledWith([
      'mator/products/new1',
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps a saved edit when the re-projection fails and says the catalog is behind', async () => {
    const { service, projection, state } = setup({ productImages: [A] });
    projection.projectProduct.mockRejectedValueOnce(new Error('db down'));

    const { data } = await service.append(
      'part_stock_7',
      galleryVersion([A]),
      [jpeg()],
      CTX,
    );
    expect(state.product).toEqual([A, uploaded(1)]);
    expect(data.catalogSynced).toBe(false);
  });
});

describe('AdminPartPhotosService.replace', () => {
  it('puts the new photo in the same position', async () => {
    const { service, state, audit } = setup({ productImages: [A, B, C] });
    await service.replace(
      'part_stock_7',
      1,
      galleryVersion([A, B, C]),
      jpeg(),
      CTX,
    );
    expect(state.product).toEqual([A, uploaded(1), C]);
    expect(state.imageUrl).toBe(A);
    expect(audit.record.mock.calls[0][0].newValues.operation).toBe('replace');
  });

  it('replacing the main photo changes what the card shows', async () => {
    const { service, state } = setup({ productImages: [BROKEN, B] });
    const { data } = await service.replace(
      'part_stock_7',
      0,
      galleryVersion([BROKEN, B]),
      jpeg(),
      CTX,
    );
    expect(state.product).toEqual([uploaded(1), B]);
    expect(state.imageUrl).toBe(uploaded(1));
    expect(data.photos[0]).toEqual({
      index: 0,
      url: uploaded(1),
      displayable: true,
    });
  });

  it('404s a position the gallery does not have, before uploading', async () => {
    const { service, cloudinary } = setup({ productImages: [A] });
    await expect(
      service.replace('part_stock_7', 3, galleryVersion([A]), jpeg(), CTX),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'PHOTO_NOT_FOUND' },
    });
    expect(cloudinary.uploadBuffer).not.toHaveBeenCalled();
  });
});

describe('AdminPartPhotosService.remove', () => {
  it('removes one photo; the next becomes the main one; no Cloudinary delete', async () => {
    const { service, state, db, cloudinary, audit } = setup({
      productImages: [A, B, C],
    });
    await service.remove('part_stock_7', 0, galleryVersion([A, B, C]), CTX);
    expect(db.productImage.createMany).toHaveBeenCalledWith({
      data: [
        { productId: 70, url: B, sortOrder: 0, isPrimary: true },
        { productId: 70, url: C, sortOrder: 1, isPrimary: false },
      ],
    });
    expect(state.imageUrl).toBe(B);
    expect(cloudinary.uploadBuffer).not.toHaveBeenCalled();
    expect(cloudinary.deleteAssets).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0][0].previousValues).toEqual({
      photos: [A, B, C],
    });
  });

  it('can remove a broken entry the buyer never saw', async () => {
    const { service, state } = setup({ productImages: [BROKEN, A] });
    const { data } = await service.remove(
      'part_stock_7',
      0,
      galleryVersion([BROKEN, A]),
      CTX,
    );
    expect(state.product).toEqual([A]);
    expect(data.photos).toEqual([{ index: 0, url: A, displayable: true }]);
  });
});

describe('AdminPartPhotosService.clear', () => {
  it('removes every photo and clears the product mirror', async () => {
    const { service, db, state, projection } = setup({ productImages: [A, B] });
    const { data } = await service.clear(
      'part_stock_7',
      galleryVersion([A, B]),
      CTX,
    );
    expect(db.productImage.deleteMany).toHaveBeenCalledWith({
      where: { productId: 70 },
    });
    expect(db.productImage.createMany).not.toHaveBeenCalled();
    expect(state.imageUrl).toBeNull();
    expect(projection.projectProduct).toHaveBeenCalled();
    expect(data.photos).toEqual([]);
    expect(data.catalogSynced).toBe(true);
  });

  it('refuses a part that already has no photos', async () => {
    const { service, audit } = setup({ productImages: [] });
    await expect(
      service.clear('part_stock_7', galleryVersion([]), CTX),
    ).rejects.toMatchObject({ status: 400, response: { code: 'NO_PHOTOS' } });
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('AdminPartPhotosService on a seeded part', () => {
  it("edits the part's own images under its row lock and does not project", async () => {
    const { service, db, state, projection, audit } = setup({
      partId: 'launch_brake_pads',
      stock: null,
      partImages: [A, B],
    });

    await service.remove('launch_brake_pads', 1, galleryVersion([A, B]), CTX);

    const lock = db.$queryRaw.mock.calls[0];
    expect(lock[0].join('?')).toContain(
      'FROM catalog_parts WHERE id = ? FOR UPDATE',
    );
    expect(lock[1]).toBe('launch_brake_pads');
    expect(db.catalogPart.update).toHaveBeenCalledWith({
      where: { id: 'launch_brake_pads' },
      data: { images: [A] },
      select: { id: true },
    });
    expect(state.part).toEqual([A]);
    expect(db.productImage.deleteMany).not.toHaveBeenCalled();
    expect(projection.projectProduct).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0][0].newValues).toEqual({
      operation: 'remove',
      photos: [A],
    });
  });
});

describe('galleryVersion', () => {
  it('depends on the order and content of the URLs', () => {
    expect(galleryVersion([A, B])).toMatch(/^[0-9a-f]{32}$/);
    expect(galleryVersion([A, B])).not.toBe(galleryVersion([B, A]));
    expect(galleryVersion([])).not.toBe(galleryVersion(['']));
  });
});
