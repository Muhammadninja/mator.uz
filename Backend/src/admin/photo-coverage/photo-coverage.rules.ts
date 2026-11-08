import { Prisma } from '@prisma/client';

/**
 * A TCP port the app can actually connect to: 1–65535, written without leading
 * zeros. Counting digits (`[0-9]{1,5}`) is not enough, since it would let
 * :99999 or :65536 through. Port 0 is refused too: a URL parser accepts it, but
 * nothing can be fetched from it. A leading zero (:0443) is refused rather than
 * guessed at, because URL parsers disagree on it.
 *
 * Ranges, longest first:
 *   65530–65535 | 65500–65529 | 65000–65499 | 60000–64999 | 10000–59999 | 1–9999
 */
const PORT_1_TO_65535 =
  '(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3})';

/**
 * What "this part has a photo" means for the admin photo-coverage console, and
 * the pure helpers its counts are built from.
 *
 * Path of a photo to the buyer: a READY draft image (its processed Cloudinary
 * upload, `secure_url`) → `product_images.url` on a listing commit or a Driver's
 * Village `1C` photo confirm → copied by the projection into
 * `catalog_parts.images` (String[]) → returned verbatim as `images` by the buyer
 * API.
 *
 * What the app does with it (MatorUI-, audited 2026-11-08):
 * - The catalog mapper keeps `images` exactly as sent (`p.images ?? []`, no
 *   filtering). Every product card — home grid, catalog and category lists,
 *   vehicle parts, similar rail, liked, the detail hero, the cart line — draws
 *   `images[0]` and nothing else.
 * - `ImageBox` shows the "no photo" placeholder at once for a falsy value ('' or
 *   null), and `AppImage` swaps in that same placeholder when the load fails. It
 *   never moves on to `images[1]`.
 * - A relative path is not a remote URL. The build has no ATS exception
 *   (infoPlist) and no Android cleartext flag, so a release build refuses
 *   `http://`.
 * - Only the detail gallery pages through the later photos, and only the search
 *   row drops blank entries before it takes [0]. Neither is the card a buyer
 *   meets first.
 *
 * So a part counts as having a photo exactly when its FIRST entry is a URL the
 * card can load: an absolute https URL with a plain host, made only of printable
 * ASCII, with no whitespace. A second photo does not stand in for a broken first.
 * Every Cloudinary upload qualifies. The image itself is not fetched: the console
 * reads no CDN.
 *
 * SQL and TypeScript use the ONE pattern below (`~*` with a bound parameter, and
 * `RegExp(…, 'i')`). It is written only with constructs that behave identically
 * in both engines: literal ASCII ranges, anchors, groups, alternation, `?` and
 * `{m,n}`. It has no `\s` / `\d` / `\w`, whose Unicode reach differs between
 * JS and PostgreSQL, and no lookaround or backreference. Both engines answer
 * "does the whole value match?" the same way for such a pattern, even though
 * PostgreSQL picks the longest alternative and JS backtracks.
 */
export const DISPLAYABLE_PHOTO_URL_PATTERN =
  '^https://[A-Za-z0-9][A-Za-z0-9.-]*' +
  `(:${PORT_1_TO_65535})?` +
  '([/?#][!-~]*)?$';

const DISPLAYABLE_PHOTO_URL = new RegExp(DISPLAYABLE_PHOTO_URL_PATTERN, 'i');

/**
 * SQL predicate: the FIRST element of the `catalog_parts` row aliased `cp` is a
 * displayable photo. It reads the row's own array, with no JOIN, so a part with
 * five photos is still one part in every COUNT.
 *
 * `array_lower` is used instead of a fixed `[1]`, so an array with a custom lower
 * bound still yields its first element, which is the one Prisma (and the app)
 * calls [0]. A NULL array, an empty array and a NULL first element all give
 * NULL. COALESCE turns that into false, so `NOT (…)` also counts such a part as
 * "without photo" instead of dropping it.
 */
export const HAS_DISPLAYABLE_PHOTO_SQL = Prisma.sql`COALESCE(cp."images"[array_lower(cp."images", 1)] ~* ${DISPLAYABLE_PHOTO_URL_PATTERN}, false)`;

/** Whether one stored `images` entry is something the app's card can load. */
export function isDisplayablePhotoUrl(value: unknown): value is string {
  return typeof value === 'string' && DISPLAYABLE_PHOTO_URL.test(value);
}

/** The photo the buyer's card shows: `images[0]` when it is displayable, else null. */
export function primaryPhoto(
  images: readonly unknown[] | null | undefined,
): string | null {
  const first = images?.[0];
  return isDisplayablePhotoUrl(first) ? first : null;
}

/** The TypeScript twin of HAS_DISPLAYABLE_PHOTO_SQL. */
export function hasDisplayablePhoto(
  images: readonly unknown[] | null | undefined,
): boolean {
  return primaryPhoto(images) !== null;
}

/** Every displayable entry, in stored order (the gallery an operator can open). */
export function displayablePhotos(
  images: readonly unknown[] | null | undefined,
): string[] {
  return (images ?? []).filter(isDisplayablePhotoUrl);
}

/** Share of `withPhotos` in `total`, in percent with one decimal; null for 0 parts. */
export function coveragePct(withPhotos: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((withPhotos / total) * 1000) / 10;
}

/** Escape `%`, `_` and `\` so an operator's text is matched literally by ILIKE. */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

// ── Category tree rollup ─────────────────────────────────────────────────────

export interface CoverageCounts {
  total: number;
  withPhotos: number;
}

export interface CoverageCategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  nameRu: string;
  nameUz: string;
  nameEn: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CategoryCoverageRow {
  id: string;
  parentId: string | null;
  /** 0 for a root, in the order the rows are returned (depth-first). */
  depth: number;
  /** INTERNAL label — never rendered; the console shows nameRu/nameUz/nameEn. */
  name: string;
  nameRu: string;
  nameUz: string;
  nameEn: string;
  isActive: boolean;
  hasChildren: boolean;
  /** Parts filed on this very node. */
  direct: CoverageCounts & { withoutPhotos: number };
  /** This node and every descendant. */
  total: number;
  withPhotos: number;
  withoutPhotos: number;
  coveragePct: number | null;
}

function bySortThenName(a: CoverageCategoryNode, b: CoverageCategoryNode) {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

function childrenIndex(nodes: readonly CoverageCategoryNode[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, CoverageCategoryNode[]>();
  const roots: CoverageCategoryNode[] = [];
  for (const n of nodes) {
    // A parent outside the set is treated as no parent, like the admin tree.
    if (n.parentId && ids.has(n.parentId) && n.parentId !== n.id) {
      children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
    } else {
      roots.push(n);
    }
  }
  for (const list of children.values()) list.sort(bySortThenName);
  roots.sort(bySortThenName);
  return { roots, children };
}

/**
 * Every category with its own and its subtree's counts, depth-first in tree
 * order (siblings by sortOrder, then name). Each part sits on exactly one
 * category, so a subtree sum counts each part once. Categories with no parts
 * are kept (all zeros). A node is visited once even if the stored tree held a
 * cycle; nodes only reachable through a cycle are appended as roots.
 */
export function buildCategoryCoverage(
  nodes: readonly CoverageCategoryNode[],
  direct: ReadonlyMap<string, CoverageCounts>,
): CategoryCoverageRow[] {
  const { roots, children } = childrenIndex(nodes);
  const visited = new Set<string>();
  const out: CategoryCoverageRow[] = [];

  const visit = (node: CoverageCategoryNode, depth: number): CoverageCounts => {
    visited.add(node.id);
    const own = direct.get(node.id) ?? { total: 0, withPhotos: 0 };
    const row: CategoryCoverageRow = {
      id: node.id,
      parentId: node.parentId,
      depth,
      name: node.name,
      nameRu: node.nameRu,
      nameUz: node.nameUz,
      nameEn: node.nameEn,
      isActive: node.isActive,
      hasChildren: false,
      direct: { ...own, withoutPhotos: own.total - own.withPhotos },
      total: 0,
      withPhotos: 0,
      withoutPhotos: 0,
      coveragePct: null,
    };
    out.push(row);
    let total = own.total;
    let withPhotos = own.withPhotos;
    for (const child of children.get(node.id) ?? []) {
      if (visited.has(child.id)) continue;
      row.hasChildren = true;
      const sub = visit(child, depth + 1);
      total += sub.total;
      withPhotos += sub.withPhotos;
    }
    row.total = total;
    row.withPhotos = withPhotos;
    row.withoutPhotos = total - withPhotos;
    row.coveragePct = coveragePct(withPhotos, total);
    return { total, withPhotos };
  };

  for (const root of roots) if (!visited.has(root.id)) visit(root, 0);
  for (const n of [...nodes].sort(bySortThenName)) {
    if (!visited.has(n.id)) visit(n, 0);
  }
  return out;
}

/** `rootId` and every descendant id (cycle-safe). */
export function subtreeIds(
  edges: readonly { id: string; parentId: string | null }[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.parentId) continue;
    children.set(e.parentId, [...(children.get(e.parentId) ?? []), e.id]);
  }
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}
