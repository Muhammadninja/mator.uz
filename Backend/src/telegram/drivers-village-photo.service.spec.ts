import {
  DV_CODE,
  FakeDrafts,
  FakePrisma,
} from '../../test/utils/dv-photo-world';
import {
  DriversVillagePhotoService,
  escapeMarkdown,
  listPositions,
  parseDvCaption,
  type DvLookup,
  type DvPosition,
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

/** The code a lookup found, every code when ambiguous, null when not found. */
const outcome = (lookup: DvLookup) =>
  lookup.kind === 'found'
    ? lookup.position.code1c
    : lookup.kind === 'ambiguous'
      ? lookup.positions.map((p) => p.code1c)
      : null;

describe('parseDvCaption', () => {
  it.each([
    ['1C 87654321', '87654321'],
    ['1С 87654321', '87654321'], // Cyrillic С, as typed on a Russian keyboard
    ['1c 87654321', '87654321'],
    ['1C: 87654321', '87654321'],
    ['1С:87654321', '87654321'],
    ['  1C   87654321 \n', '87654321'],
    ['1C 96273708 GMB', '96273708 GMB'],
    ['1C 96273708  GMB', '96273708 GMB'], // no-break spaces
    ['1C 02E-409-359', '02E-409-359'],
    ['1C 02E‑409–359', '02E-409-359'], // phone dash look-alikes
    ['1C 12605566pmc', '12605566pmc'], // as typed: code_1c is stored verbatim
    ['1C 1C0919275', '1C0919275'],
    ['1C бп-01068170', 'БП-01068170'], // a legacy code is uppercased, as before
    // Articles of letters, digits, single spaces and hyphens (code1cIssue).
    ['1C SCT SB 061-0868', 'SCT SB 061-0868'],
    ['1C SCT  SB 061-0868', 'SCT SB 061-0868'], // a typed double space
    ['1C БП 010', 'БП 010'],
    ['1C 94583379S&T', '94583379S&T'],
  ])('%p → photo update of %p', (caption, code1c) => {
    expect(parseDvCaption(caption)).toEqual({ kind: 'code', code1c });
  });

  it.each([
    ['00-00001431', '00-00001431'],
    ['  БП-01068170 \n', 'БП-01068170'],
    ['бп-01068170', 'БП-01068170'],
    ['00–00001431', '00-00001431'], // en dash typed by a phone keyboard
  ])('a legacy code needs no marker: %p → %p', (caption, code1c) => {
    expect(parseDvCaption(caption)).toEqual({ kind: 'code', code1c });
  });

  it.each([
    null,
    '',
    'Колодки передние',
    '87654321', // an article without the marker stays with the listing wizard
    '96273708 GMB',
    'SP-1362',
    '00-00001431 Амортизатор', // a code plus text is not a legacy code
    '1C0919275', // no separator after "1C": a code, not the marker
  ])('%p is not a photo update (ordinary listing flow)', (caption) => {
    expect(parseDvCaption(caption)).toEqual({ kind: 'none' });
  });

  it.each([
    '1C',
    '1C:',
    '1С ',
    '1C Фильтр масляный', // a product name, no article
    '1C 1', // a placeholder, never imported
    '1C 3333',
    '1C ???',
    `1C ${'9'.repeat(65)}`, // longer than any stored code_1c
  ])('%p is refused: the marker without a valid code', (caption) => {
    expect(parseDvCaption(caption)).toEqual({ kind: 'invalid' });
  });

  it('escapes legacy-Markdown characters in dynamic preview values', () => {
    expect(escapeMarkdown('Фильтр *мас_ла* [x] `y`')).toBe(
      'Фильтр \\*мас\\_ла\\* \\[x] \\`y\\`',
    );
  });

  it('lists the positions of an ambiguous code one per line, capped at 10', () => {
    const p = (code1c: string, title: string) =>
      ({ code1c, title }) as DvPosition;
    expect(
      listPositions([p('96273708 GMB', 'Фильтр'), p('96273708 OEM', 'Фильтр')]),
    ).toBe('• 96273708 GMB — Фильтр\n• 96273708 OEM — Фильтр');
    const lines = listPositions(
      Array.from({ length: 12 }, (_, i) => p(`9627370${i}`, 'x')),
    ).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe('…');
  });
});

describe('DriversVillagePhotoService.resolvePosition', () => {
  it('finds the position by (DV business seller, DRIVERS_VILLAGE_1C, code_1c)', async () => {
    const { world, svc } = setup();
    await expect(svc.resolvePosition(DV_CODE)).resolves.toEqual({
      kind: 'found',
      position: {
        sellerId: 7,
        stockId: 500,
        productId: 100,
        code1c: DV_CODE,
        title: 'Амортизатор передний RH',
        imageCount: 2,
      },
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
    await expect(svc.resolvePosition('96611630')).resolves.toEqual({
      kind: 'notFound',
    });
    expect(world.reads.some((r) => r.model === 'product')).toBe(false);
    expect(world.writes).toEqual([]);
  });

  it('matches the code exactly as stored: verbatim, case included', async () => {
    const { world, svc } = setup();
    world.addDvPosition({
      stockId: 501,
      productId: 101,
      code: '12605566pmc',
      title: 'Прокладка',
    });
    expect(outcome(await svc.resolvePosition('12605566pmc'))).toBe(
      '12605566pmc',
    );
    expect(outcome(await svc.resolvePosition('12605566PMC'))).toBeNull();
  });

  it('the exact code wins over its 8-digit key', async () => {
    const { world, svc } = setup();
    world.addDvPosition({
      stockId: 501,
      productId: 101,
      code: '96273708',
      title: 'Фильтр',
    });
    world.addDvPosition({
      stockId: 502,
      productId: 102,
      code: '96273708 GMB',
      title: 'Фильтр GMB',
    });
    expect(outcome(await svc.resolvePosition('96273708'))).toBe('96273708');
    expect(outcome(await svc.resolvePosition('96273708 GMB'))).toBe(
      '96273708 GMB',
    );
  });

  it('by the key, the bare article and the article with a marker find each other', async () => {
    const bare = setup();
    bare.world.addDvPosition({
      stockId: 501,
      productId: 101,
      code: '96273708',
      title: 'Фильтр',
    });
    expect(outcome(await bare.svc.resolvePosition('96273708 GMB'))).toBe(
      '96273708',
    );
    expect(outcome(await bare.svc.resolvePosition('GMB 96273708'))).toBe(
      '96273708',
    );

    const marked = setup();
    marked.world.addDvPosition({
      stockId: 502,
      productId: 102,
      code: '96273708 GMB',
      title: 'Фильтр GMB',
    });
    expect(outcome(await marked.svc.resolvePosition('96273708'))).toBe(
      '96273708 GMB',
    );
    expect(marked.world.writes).toEqual([]);
  });

  it('one marker for another, or another 1C series, proves nothing', async () => {
    const { world, svc } = setup();
    world.addDvPosition({
      stockId: 502,
      productId: 102,
      code: '96273708 GMB',
      title: 'Фильтр GMB',
    });
    expect(outcome(await svc.resolvePosition('96273708 OEM'))).toBeNull();
    // DV_CODE (00-00001431) is stored; the same digits in another series:
    expect(outcome(await svc.resolvePosition('БП-00001431'))).toBeNull();
  });

  it('a key that links several positions is ambiguous: all listed, none chosen', async () => {
    const { world, svc } = setup();
    world.addDvPosition({
      stockId: 502,
      productId: 102,
      code: '96273708 OEM',
      title: 'Фильтр OEM',
    });
    world.addDvPosition({
      stockId: 503,
      productId: 103,
      code: '96273708 GMB',
      title: 'Фильтр GMB',
    });
    expect(outcome(await svc.resolvePosition('96273708'))).toEqual([
      '96273708 GMB',
      '96273708 OEM',
    ]);
    expect(world.writes).toEqual([]);
  });

  it("the key never reaches another seller's stock", async () => {
    const { world, svc } = setup();
    world.addDvPosition({
      stockId: 700,
      productId: 201,
      code: '96273708 GMB',
      title: 'Чужая позиция',
    });
    world.state.stocks.at(-1)!.sellerId = 1; // the Telegram seller's
    expect(outcome(await svc.resolvePosition('96273708'))).toBeNull();
  });

  it('resolves nothing when the dealer seller is missing or is not BUSINESS', async () => {
    const missing = setup();
    missing.world.state.sellers = missing.world.state.sellers.filter(
      (s) => s.id !== 7,
    );
    await expect(missing.svc.resolvePosition(DV_CODE)).resolves.toEqual({
      kind: 'notFound',
    });

    const telegram = setup();
    telegram.world.state.sellers[0].sellerType = 'TELEGRAM';
    await expect(telegram.svc.resolvePosition(DV_CODE)).resolves.toEqual({
      kind: 'notFound',
    });
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
    const lookup = await svc.resolvePosition(DV_CODE);
    if (lookup.kind !== 'found') throw new Error('fixture position missing');
    const draft = await svc.createPhotoDraft({
      position: lookup.position,
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
    // The product row is locked before its gallery is touched, and imageUrl
    // is the ONLY product column written.
    expect(world.writes).toEqual([
      'product.lock:100',
      'productImage.deleteMany:100',
      'productImage.createMany:100',
      'product.update:100:imageUrl',
    ]);
  });

  it('two concurrent confirms of one product leave ONE gallery with one primary photo', async () => {
    const { world, svc } = setup();
    const a = ['https://cdn/a0.jpg', 'https://cdn/a1.jpg'];
    const b = ['https://cdn/b0.jpg', 'https://cdn/b1.jpg'];

    await Promise.all([svc.replaceGallery(500, a), svc.replaceGallery(500, b)]);

    const gallery = world.state.productImages.filter(
      (i) => i.productId === 100,
    );
    expect([a, b]).toContainEqual(gallery.map((i) => i.url));
    expect(gallery.filter((i) => i.isPrimary)).toHaveLength(1);
    expect(world.state.products[0].imageUrl).toBe(gallery[0].url);
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
