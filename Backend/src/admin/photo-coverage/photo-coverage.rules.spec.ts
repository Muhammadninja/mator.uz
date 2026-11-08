// The photo rule and the category rollup the coverage console counts with.
//
// The rule follows the buyer app's product card: it draws images[0] and only
// images[0] (ImageBox → AppImage → placeholder on a falsy value or a failed
// load; never the next photo). See photo-coverage.rules.ts.

import {
  buildCategoryCoverage,
  CoverageCategoryNode,
  coveragePct,
  displayablePhotos,
  DISPLAYABLE_PHOTO_URL_PATTERN,
  HAS_DISPLAYABLE_PHOTO_SQL,
  hasDisplayablePhoto,
  isDisplayablePhotoUrl,
  likeContains,
  primaryPhoto,
  subtreeIds,
} from './photo-coverage.rules';

const CLOUDINARY =
  'https://res.cloudinary.com/mator/image/upload/v1730000000/products/abc.png';
const CLOUDINARY_2 =
  'https://res.cloudinary.com/mator/image/upload/v1730000001/products/def.png';

const node = (
  id: string,
  parentId: string | null,
  over: Partial<CoverageCategoryNode> = {},
): CoverageCategoryNode => ({
  id,
  parentId,
  name: id,
  nameRu: `ru ${id}`,
  nameUz: `uz ${id}`,
  nameEn: `en ${id}`,
  isActive: true,
  sortOrder: 0,
  ...over,
});

describe('isDisplayablePhotoUrl', () => {
  it.each([
    [CLOUDINARY, 'a Cloudinary upload'],
    ['HTTPS://RES.CLOUDINARY.COM/X.PNG', 'scheme and host in capitals'],
    ['https://cdn.example.com/a.jpg?w=1&h=2#frag', 'query and fragment'],
    ['https://res.cloudinary.com:443/x.png', 'explicit port'],
    ['https://cdn.example.com', 'host only'],
    [
      'https://cdn.example.com/%D1%84%D0%BE%D1%82%D0%BE.png',
      'percent-encoded path',
    ],
  ])('accepts %j (%s)', (url) => {
    expect(isDisplayablePhotoUrl(url)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    [
      'http://res.cloudinary.com/x.png',
      'cleartext http (refused by ATS / Android)',
    ],
    ['/uploads/x.png', 'relative'],
    ['res.cloudinary.com/x.png', 'no scheme'],
    ['//res.cloudinary.com/x.png', 'scheme-relative'],
    ['https://', 'no host'],
    ['https:///x.png', 'empty host'],
    ['https://-bad.example/x.png', 'host starting with a hyphen'],
    ['https://host:999999/x.png', 'six-digit port'],
    ['https://host:99999/image.jpg', 'five-digit port above 65535'],
    ['https://host:65536/x.png', 'port 65536'],
    ['https://host:0/x.png', 'port 0'],
    ['https://host:0443/x.png', 'port with a leading zero'],
    ['https://host:/x.png', 'empty port'],
    ['https://host:44a/x.png', 'non-numeric port'],
    [
      ' https://res.cloudinary.com/x.png',
      'leading space (the app does not trim)',
    ],
    ['https://res.cloudinary.com/x.png ', 'trailing space'],
    ['https://res.cloudinary.com/x.png\n', 'trailing newline'],
    ['https://res.cloudinary.com/a b.png', 'inner space'],
    ['https://res.cloudinary.com/a\u00a0b.png', 'no-break space'],
    ['https://cdn.example.com/фото.png', 'raw non-ASCII path'],
    ['data:image/png;base64,AAAA', 'data URI'],
    ['ftp://cdn.example.com/x.png', 'other scheme'],
  ])('refuses %j (%s)', (url) => {
    expect(isDisplayablePhotoUrl(url)).toBe(false);
  });

  it('refuses non-strings', () => {
    expect(isDisplayablePhotoUrl(null)).toBe(false);
    expect(isDisplayablePhotoUrl(undefined)).toBe(false);
    expect(isDisplayablePhotoUrl(42)).toBe(false);
  });
});

/**
 * One table for the whole rule: the stored `images`, and whether the buyer's
 * card shows a photo. hasDisplayablePhoto is the TypeScript twin of the SQL
 * predicate, and both read only the first element.
 */
const CASES: [string, (string | null)[] | null, boolean][] = [
  ['one good photo', [CLOUDINARY], true],
  ['several good photos', [CLOUDINARY, CLOUDINARY_2], true],
  ['good first, broken second', [CLOUDINARY, ''], true],
  ['empty array', [], false],
  ['NULL array', null, false],
  ['empty string first, good second', ['', CLOUDINARY], false],
  ['blank first, good second', ['   ', CLOUDINARY], false],
  ['NULL element first, good second', [null, CLOUDINARY], false],
  ['relative first, good second', ['/uploads/a.png', CLOUDINARY], false],
  [
    'http first, good second',
    ['http://res.cloudinary.com/a.png', CLOUDINARY],
    false,
  ],
  ['garbage first, good second', ['not a url', CLOUDINARY], false],
  ['only broken entries', ['', 'http://x/y.png', '/z.png'], false],
];

describe('the port', () => {
  it('accepts exactly 1–65535, checked for every value from 0 to 70000', () => {
    const wrong: number[] = [];
    for (let port = 0; port <= 70_000; port += 1) {
      const ok = isDisplayablePhotoUrl(`https://host:${port}/image.jpg`);
      if (ok !== (port >= 1 && port <= 65_535)) wrong.push(port);
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ['https://host:1/x.png'],
    ['https://host:443/x.png'],
    ['https://host:8080'],
    ['https://host:65535/x.png'],
    ['https://host:65535?w=1'],
  ])('accepts %s', (url) => {
    expect(isDisplayablePhotoUrl(url)).toBe(true);
  });

  it('decides the photo state, so an out-of-range port is never green', () => {
    expect(hasDisplayablePhoto(['https://host:99999/image.jpg'])).toBe(false);
    expect(hasDisplayablePhoto(['https://host:65535/image.jpg'])).toBe(true);
  });
});

describe('hasDisplayablePhoto / primaryPhoto (first element only)', () => {
  it.each(CASES)('%s → %s', (_label, images, expected) => {
    expect(hasDisplayablePhoto(images)).toBe(expected);
    expect(primaryPhoto(images)).toBe(expected ? images![0] : null);
  });
});

describe('displayablePhotos (the operator gallery)', () => {
  it('keeps every displayable entry, in stored order, whatever the first is', () => {
    expect(
      displayablePhotos(['', CLOUDINARY, 'http://x/y.png', 'https://b/c.png']),
    ).toEqual([CLOUDINARY, 'https://b/c.png']);
  });

  it('treats a NULL or empty array as no photo', () => {
    expect(displayablePhotos(null)).toEqual([]);
    expect(displayablePhotos(undefined)).toEqual([]);
    expect(displayablePhotos([])).toEqual([]);
  });
});

describe('HAS_DISPLAYABLE_PHOTO_SQL', () => {
  it("tests the first element of the row's own array, NULL-safe, with the same bound pattern", () => {
    expect(HAS_DISPLAYABLE_PHOTO_SQL.text).toBe(
      'COALESCE(cp."images"[array_lower(cp."images", 1)] ~* $1, false)',
    );
    expect(HAS_DISPLAYABLE_PHOTO_SQL.values).toEqual([
      DISPLAYABLE_PHOTO_URL_PATTERN,
    ]);
    expect(HAS_DISPLAYABLE_PHOTO_SQL.text).not.toMatch(/JOIN|unnest|EXISTS/i);
  });

  it('uses only regex syntax that PostgreSQL ARE and JavaScript read the same way', () => {
    // Printable ASCII only, and no backslash at all: no \s \d \w (their Unicode
    // reach differs between the engines), no escapes, no backreferences.
    expect(DISPLAYABLE_PHOTO_URL_PATTERN).toMatch(/^[\x20-\x7e]+$/);
    expect(DISPLAYABLE_PHOTO_URL_PATTERN).not.toContain('\\');
    // No lookaround or non-capturing groups (JS-only "(?…"), no POSIX classes
    // or collating elements (PostgreSQL-only "[:", "[.", "[=").
    expect(DISPLAYABLE_PHOTO_URL_PATTERN).not.toContain('(?');
    expect(DISPLAYABLE_PHOTO_URL_PATTERN).not.toMatch(/\[[:.=]/);
    // Anchored at both ends, so ~* (a search) and RegExp.test agree on "whole value".
    expect(DISPLAYABLE_PHOTO_URL_PATTERN.startsWith('^')).toBe(true);
    expect(DISPLAYABLE_PHOTO_URL_PATTERN.endsWith('$')).toBe(true);
  });
});

describe('coveragePct', () => {
  it('is withPhotos / total × 100, one decimal', () => {
    expect(coveragePct(1, 3)).toBe(33.3);
    expect(coveragePct(2, 3)).toBe(66.7);
    expect(coveragePct(5, 5)).toBe(100);
    expect(coveragePct(0, 7)).toBe(0);
  });

  it('is null when there are no parts', () => {
    expect(coveragePct(0, 0)).toBeNull();
  });
});

describe('likeContains', () => {
  it('wraps the term and escapes LIKE wildcards', () => {
    expect(likeContains('96484900')).toBe('%96484900%');
    expect(likeContains('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});

describe('buildCategoryCoverage', () => {
  const tree = [
    node('brakes', null, { sortOrder: 1 }),
    node('pads', 'brakes', { sortOrder: 2 }),
    node('discs', 'brakes', { sortOrder: 1 }),
    node('engine', null, { sortOrder: 0 }),
    node('empty', null, { sortOrder: 5 }),
  ];
  const direct = new Map([
    ['brakes', { total: 1, withPhotos: 0 }],
    ['pads', { total: 4, withPhotos: 3 }],
    ['discs', { total: 2, withPhotos: 0 }],
    ['engine', { total: 3, withPhotos: 3 }],
  ]);

  it('orders rows depth-first by sortOrder and gives each a depth', () => {
    const rows = buildCategoryCoverage(tree, direct);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['engine', 0],
      ['brakes', 0],
      ['discs', 1],
      ['pads', 1],
      ['empty', 0],
    ]);
  });

  it('rolls a subtree up from its own parts and its descendants', () => {
    const brakes = buildCategoryCoverage(tree, direct).find(
      (r) => r.id === 'brakes',
    )!;
    expect(brakes.direct).toEqual({
      total: 1,
      withPhotos: 0,
      withoutPhotos: 1,
    });
    expect(brakes).toMatchObject({
      total: 7,
      withPhotos: 3,
      withoutPhotos: 4,
      coveragePct: 42.9,
      hasChildren: true,
    });
  });

  it('keeps a category with no parts, and one with no photos', () => {
    const rows = buildCategoryCoverage(tree, direct);
    expect(rows.find((r) => r.id === 'empty')).toMatchObject({
      total: 0,
      withPhotos: 0,
      withoutPhotos: 0,
      coveragePct: null,
      hasChildren: false,
    });
    expect(rows.find((r) => r.id === 'discs')).toMatchObject({
      total: 2,
      withPhotos: 0,
      withoutPhotos: 2,
      coveragePct: 0,
    });
  });

  it('root subtrees add up to the overall total: no part is counted twice', () => {
    const rows = buildCategoryCoverage(tree, direct);
    const roots = rows.filter((r) => r.depth === 0);
    const directSum = [...direct.values()].reduce((s, c) => s + c.total, 0);
    expect(roots.reduce((s, r) => s + r.total, 0)).toBe(directSum);
    expect(roots.reduce((s, r) => s + r.withPhotos, 0)).toBe(6);
  });

  it('treats a parent outside the set as a root', () => {
    const rows = buildCategoryCoverage([node('lost', 'missing')], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'lost', depth: 0 });
  });

  it('terminates on a cycle and still lists every node once', () => {
    const rows = buildCategoryCoverage(
      [node('a', 'b'), node('b', 'a')],
      new Map([
        ['a', { total: 1, withPhotos: 1 }],
        ['b', { total: 2, withPhotos: 0 }],
      ]),
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(rows[0].total).toBe(3);
  });
});

describe('subtreeIds', () => {
  const edges = [
    { id: 'root', parentId: null },
    { id: 'a', parentId: 'root' },
    { id: 'a1', parentId: 'a' },
    { id: 'b', parentId: 'root' },
    { id: 'other', parentId: null },
  ];

  it('is the node and every descendant', () => {
    expect(subtreeIds(edges, 'root').sort()).toEqual(['a', 'a1', 'b', 'root']);
    expect(subtreeIds(edges, 'a').sort()).toEqual(['a', 'a1']);
    expect(subtreeIds(edges, 'a1')).toEqual(['a1']);
  });

  it('is just the id for an unknown category, and is cycle-safe', () => {
    expect(subtreeIds(edges, 'nope')).toEqual(['nope']);
    expect(
      subtreeIds(
        [
          { id: 'x', parentId: 'y' },
          { id: 'y', parentId: 'x' },
        ],
        'x',
      ).sort(),
    ).toEqual(['x', 'y']);
  });
});
