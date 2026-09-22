import {
  DV_CODE,
  FakeDrafts,
  FakePrisma,
} from '../../test/utils/dv-photo-world';
import {
  DriversVillagePhotoService,
  code1cFromCaption,
  escapeMarkdown,
} from './drivers-village-photo.service';
import type { ProductDraftService } from './product-draft.service';

function setup() {
  const world = new FakePrisma();
  const drafts = new FakeDrafts(world);
  const svc = new DriversVillagePhotoService(
    world.prisma,
    drafts as unknown as ProductDraftService,
  );
  return { world, drafts, svc };
}

describe('code1cFromCaption', () => {
  it.each([
    ['00-00001431', '00-00001431'],
    ['  БП-01068170 \n', 'БП-01068170'],
    ['бп-01068170', 'БП-01068170'],
    ['00–00001431', '00-00001431'], // en dash typed by a phone keyboard
  ])('%p → %p', (caption, code) => {
    expect(code1cFromCaption(caption)).toBe(code);
  });

  it.each([
    null,
    '',
    'Колодки передние',
    '96611630', // a GM/OEM number is not a code_1c
    'SP-1362',
    '00-00001431 Амортизатор', // a code plus text is not a code
  ])('%p is not a code_1c (ordinary listing flow)', (caption) => {
    expect(code1cFromCaption(caption)).toBeNull();
  });

  it('escapes legacy-Markdown characters in dynamic preview values', () => {
    expect(escapeMarkdown('Фильтр *мас_ла* [x] `y`')).toBe(
      'Фильтр \\*мас\\_ла\\* \\[x] \\`y\\`',
    );
  });
});

describe('DriversVillagePhotoService.resolvePosition', () => {
  it('finds the position by (DV business seller, DRIVERS_VILLAGE_1C, code_1c) only', async () => {
    const { world, svc } = setup();
    await expect(svc.resolvePosition(DV_CODE)).resolves.toEqual({
      sellerId: 7,
      stockId: 500,
      productId: 100,
      code1c: DV_CODE,
      title: 'Амортизатор передний RH',
      imageCount: 2,
    });
    expect(world.reads).toEqual([
      { model: 'seller', where: { catalogSellerId: 'drivers-village' } },
      {
        model: 'stock',
        where: {
          sellerId_sourceSystem_sourceCode: {
            sellerId: 7,
            sourceSystem: 'DRIVERS_VILLAGE_1C',
            sourceCode: DV_CODE,
          },
        },
      },
    ]);
    expect(world.writes).toEqual([]);
  });

  it('never matches by GM/OEM number: the shared number resolves to nothing', async () => {
    const { world, svc } = setup();
    await expect(svc.resolvePosition('96611630')).resolves.toBeNull();
    expect(world.reads.some((r) => r.model === 'product')).toBe(false);
    expect(world.writes).toEqual([]);
  });

  it('resolves nothing when the dealer seller is missing or is not BUSINESS', async () => {
    const missing = setup();
    missing.world.state.sellers = missing.world.state.sellers.filter(
      (s) => s.id !== 7,
    );
    await expect(missing.svc.resolvePosition(DV_CODE)).resolves.toBeNull();

    const telegram = setup();
    telegram.world.state.sellers[0].sellerType = 'TELEGRAM';
    await expect(telegram.svc.resolvePosition(DV_CODE)).resolves.toBeNull();
  });

  it('re-checks identity when resolving by stock id (a Telegram stock is never a DV target)', async () => {
    const { svc } = setup();
    await expect(svc.describeTarget(500)).resolves.toMatchObject({
      productId: 100,
    });
    await expect(svc.describeTarget(600)).resolves.toBeNull();
  });
});

describe('DriversVillagePhotoService.createPhotoDraft', () => {
  it('creates a PHOTO-UPDATE draft owned by the DV seller, targeting the stock', async () => {
    const { drafts, svc, world } = setup();
    const position = (await svc.resolvePosition(DV_CODE))!;
    const draft = await svc.createPhotoDraft({
      position,
      tgUserId: 42,
      fileIds: ['a', 'b'],
      expiresAt: new Date(0),
    });
    expect(draft).toMatchObject({
      sellerId: 7,
      tgId: BigInt(42),
      targetStockId: 500,
      formStep: 'QUESTIONNAIRE_DONE',
    });
    expect(draft.images.map((i) => [i.sortOrder, i.tgFileId])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
    expect(drafts.createWithImages).toHaveBeenCalledTimes(1);
    expect(world.writes).toEqual([]); // no product/photo write at upload time
  });
});

describe('DriversVillagePhotoService.replaceGallery', () => {
  it('replaces only the target gallery: ordered, first primary, imageUrl mirrors it', async () => {
    const { world, svc } = setup();
    const urls = [
      'https://cdn/n0.jpg',
      'https://cdn/n1.jpg',
      'https://cdn/n2.jpg',
    ];

    await expect(svc.replaceGallery(500, urls)).resolves.toMatchObject({
      productId: 100,
    });

    expect(
      world.state.productImages.filter((i) => i.productId === 100),
    ).toEqual([
      { productId: 100, url: urls[0], sortOrder: 0, isPrimary: true },
      { productId: 100, url: urls[1], sortOrder: 1, isPrimary: false },
      { productId: 100, url: urls[2], sortOrder: 2, isPrimary: false },
    ]);
    expect(world.state.products[0].imageUrl).toBe(urls[0]);
    // The Telegram listing with the same number is untouched.
    expect(
      world.state.productImages.filter((i) => i.productId === 200),
    ).toEqual([
      {
        productId: 200,
        url: 'https://tg/0.jpg',
        sortOrder: 0,
        isPrimary: true,
      },
    ]);
    // imageUrl is the ONLY product column written.
    expect(world.writes).toEqual([
      'productImage.deleteMany:100',
      'productImage.createMany:100',
      'product.update:100:imageUrl',
    ]);
  });

  it('writes nothing when the stock is no longer a DV position', async () => {
    const { world, svc } = setup();
    world.state.stocks[0].sourceSystem = null;
    await expect(
      svc.replaceGallery(500, ['https://cdn/n0.jpg']),
    ).resolves.toBeNull();
    expect(world.writes).toEqual([]);
  });

  it('refuses an empty gallery', async () => {
    const { world, svc } = setup();
    await expect(svc.replaceGallery(500, [])).rejects.toThrow(/no images/);
    expect(world.writes).toEqual([]);
  });
});
