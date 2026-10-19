/**
 * The 8-digit key of a code_1c. `96273708`, `96273708 GMB` and `96273708 OEM`
 * all carry the key `96273708`.
 *
 * The importer finds a stored position by its exact code_1c ONLY (seller,
 * DRIVERS_VILLAGE_1C, code_1c). The key never makes one code update or take
 * over another code's position: a marker is often another brand
 * (`96273708PMC(EU)`, `94583379S&T`), so a takeover could put one part's price
 * on another. The key is used for two things only: reporting codes that share
 * it (possibly a code renamed in 1C — an operator decides, the import never
 * merges) and the OEM search index of a new position. Pure: no I/O.
 *
 * Also home of the one validity rule of a code_1c (code1cIssue) and of the key
 * evidence rule (keyProvesSamePart), both shared with the Telegram photo flow.
 */
import { normalizeOem } from '../../common/normalize-oem.util';
import { FIELD_LIMITS } from './drivers-village.constants';
import type { ImportIssue, ParsedRow } from './drivers-village.types';

const KEY_DIGITS = 8;

/**
 * The one run of exactly 8 digits in a code, bounded by the ends of the code
 * or by non-digits: `96273708`, `96273708 GMB`, `GMB 96273708`, `96273708-OEM`
 * → `96273708`. Null when there is no such run or more than one; never cut
 * out of a longer run (`123456789`, `1234567890`). Any decimal digit extends
 * a run, but only a run of ASCII digits is a key.
 */
export function eightDigitKey(code: string): string | null {
  const runs = (code.match(/\p{Nd}+/gu) ?? []).filter(
    (run) => [...run].length === KEY_DIGITS,
  );
  return runs.length === 1 && /^[0-9]+$/.test(runs[0]) ? runs[0] : null;
}

/**
 * Whether the 8-digit key proves two codes are one part: they share the key
 * and one of them IS the bare article — `96273708` ↔ `96273708 GMB`, either
 * way. One marker replaced by another (`96273708 GMB` ↔ `96273708 OEM`) or
 * another 1C series (`00-00001431` ↔ `БП-00001431`) proves nothing.
 */
export function keyProvesSamePart(a: string, b: string): boolean {
  const key = eightDigitKey(a);
  return key !== null && key === eightDigitKey(b) && (a === key || b === key);
}

/** Why a code_1c cannot identify a position (see code1cIssue). */
export interface Code1cIssue {
  code:
    | 'empty_code_1c'
    | 'invalid_code_1c'
    | 'name_as_code_1c'
    | 'placeholder_code_1c';
  message: string;
}

const invalid = (message: string): Code1cIssue => ({
  code: 'invalid_code_1c',
  message,
});

/**
 * The one validity rule of a code_1c, or null when the code is valid. The code
 * is the position's identity and is stored verbatim (trimmed only): nothing is
 * case-folded, collapsed or stripped, so two different codes never become one.
 * Valid:
 *   • every code accepted before: one token of letters, digits and `._/-`
 *     (`00-00067316`, `_БП-01074259`, `93186310-` — a trailing dash marks a
 *     separate 1C position), or an 8-digit article and a marker split by
 *     single spaces (`96273708 GMB`);
 *   • an article of tokens split by single spaces — `SCT SB 061-0868`,
 *     `K0000049 H6`, `PFA 235` — that holds a digit and no Russian word (a
 *     value like `Фильтр топливного насоса` or `Castrol EDGE` is a product
 *     name in the code column, not an article);
 *   • `&`, `+` and balanced parentheses inside a token: `94583379S&T`,
 *     `96273708PMC(EU)`, `4260360943454 12+`.
 * Never: empty; over 64 characters; irregular whitespace (two spaces, a tab,
 * a no-break space) or any other punctuation (`RXA06820 ,`); one character
 * repeated (a placeholder: `3333`, `3333333`), checked separately.
 * The importer checks a row's code with it and the Telegram photo flow a
 * caption's code, so a caption can name exactly the codes an import stores.
 */
export function code1cIssue(code1c: string | null): Code1cIssue | null {
  if (!code1c) return { code: 'empty_code_1c', message: 'code_1c is empty' };
  if (code1c.length > FIELD_LIMITS.code1c)
    return invalid(`code_1c longer than ${FIELD_LIMITS.code1c} characters`);
  if (!isAcceptedBefore(code1c)) {
    const reason = articleIssue(code1c);
    if (reason) return reason;
  }
  // "1", "B", "3333", "222222": in the dv_parts exports such codes are shared
  // by unrelated goods (code "1": 22 rows, 22 different names), so they are
  // placeholders — importing them would merge different parts into one.
  if (/^(.)\1*$/u.test(code1c))
    return {
      code: 'placeholder_code_1c',
      message: `code_1c "${code1c}" is one character repeated — a placeholder, not a part number`,
    };
  return null;
}

/**
 * The rule in force until 2026-10-19, kept as is so that no code an earlier
 * import stored stops matching its position: one token of letters, digits
 * and `._/-`, or an 8-digit article and markers split by single spaces.
 */
function isAcceptedBefore(code: string): boolean {
  return (
    /^[\p{L}\p{N}._/-]+$/u.test(code) ||
    (/^[\p{L}\p{N}._/-]+(?: [\p{L}\p{N}._/-]+)+$/u.test(code) &&
      eightDigitKey(code) !== null)
  );
}

/** One token of an article: letters and digits joined by `- . / _ & + ( )`. */
const ARTICLE_TOKEN = /^[\p{L}\p{N}._/&+()-]+$/u;

/** Why a code accepted only by the article rule fails it, or null. */
function articleIssue(code: string): Code1cIssue | null {
  if (!/^\S+(?: \S+)*$/u.test(code))
    return invalid(
      `code_1c "${code}" has irregular spacing — the parts of an article are split by single spaces`,
    );
  const tokens = code.split(' ');
  const bad = tokens.find(
    (t) =>
      !ARTICLE_TOKEN.test(t) || !/[\p{L}\p{N}]/u.test(t) || !balancedParens(t),
  );
  if (bad)
    return invalid(
      `code_1c "${code}": "${bad}" is not part of an article — only letters, digits and - . / _ & + ( ) are accepted`,
    );
  if (tokens.length > 1 && /[а-яё]{3}/u.test(code))
    return {
      code: 'name_as_code_1c',
      message: `code_1c "${code}" holds a Russian word — a product name in the code column, not an article`,
    };
  if (tokens.length > 1 && !/\p{N}/u.test(code))
    return {
      code: 'name_as_code_1c',
      message: `code_1c "${code}" has several words and no digit — a name in the code column, not an article`,
    };
  return null;
}

function balancedParens(token: string): boolean {
  let depth = 0;
  for (const ch of token) {
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** The codes a new code shares its key with. Nothing is ever merged. */
export interface KeyShare {
  key: string;
  /** Other codes of the file with the key. */
  fileCodes: string[];
  /** Positions stored with the key whose code is not in this file. */
  storedCodes: string[];
  /**
   * The stored codes the key ties to this one as the bare article and the
   * article with a marker (keyProvesSamePart): possibly the same part renamed
   * in 1C. Reported only — the import never renames or merges positions.
   */
  possibleRenameOf: string[];
}

export interface KeyResolution {
  /**
   * code_1c without a stored position of its own → the codes it shares its
   * key with. It is created as a position of its own.
   */
  shared: Map<string, KeyShare>;
  /**
   * code_1c → its key, when no other position of this seller carries that
   * value (as its own key or its normalized code): only then may the key join
   * the code's OEM index. That index also binds the dealer's 1C stock uploads
   * (sync-inventory takes the first catalog part with the article), so a value
   * on two positions would let the stock of one reach the other.
   */
  searchKeys: Map<string, string>;
  /**
   * code_1c without a stored position of its own → the other codes (in the
   * file or stored) that carry its search number (normalizeOem) as their own
   * search form or as their 8-digit key, e.g. `PFA 235` and `PFA 235-`, or
   * `96273708` and a stored `96273708 GMB`. They stay separate positions;
   * reported because a buyer search and a sync-inventory upload cannot tell
   * them apart (a stored position's index is never changed by the sync).
   */
  sameSearchNumber: Map<string, string[]>;
}

/**
 * How the codes of a file relate to the stored ones through the 8-digit key
 * and the OEM search form. A code with a stored position of its own updates
 * that position; every other code is a NEW position — never a takeover of a
 * stored one, whatever its key says (see the file header).
 * `fileCodes` must hold the code_1c of EVERY row, rejected rows included: a
 * code still in the export keeps its position even while its row is rejected.
 */
export function resolveCodeKeys(
  fileCodes: Iterable<string>,
  storedCodes: Iterable<string>,
): KeyResolution {
  const inFile = new Set(fileCodes);
  const stored = new Set(storedCodes);
  const groups = new Map<string, { file: string[]; stored: string[] }>();
  const group = (key: string) => {
    const g = groups.get(key) ?? { file: [], stored: [] };
    groups.set(key, g);
    return g;
  };
  for (const code of inFile) {
    const key = eightDigitKey(code);
    if (key) group(key).file.push(code);
  }
  for (const code of stored) {
    const key = eightDigitKey(code);
    if (key && groups.has(key)) group(key).stored.push(code);
  }

  const out: KeyResolution = {
    shared: new Map(),
    searchKeys: new Map(),
    sameSearchNumber: new Map(),
  };
  for (const [key, g] of groups) {
    const free = g.stored.filter((c) => !inFile.has(c)).sort();
    for (const code of g.file) {
      if (stored.has(code)) continue; // its own position
      const fileOthers = g.file.filter((c) => c !== code);
      if (fileOthers.length === 0 && free.length === 0) continue;
      out.shared.set(code, {
        key,
        fileCodes: fileOthers,
        storedCodes: free,
        possibleRenameOf: free.filter((s) => keyProvesSamePart(code, s)),
      });
    }
  }

  // Every code is its own position: who carries each search value (its own
  // search form or its 8-digit key).
  const holders = new Map<string, Set<string>>();
  // Who may carry a NEW code's number in its index: any code by its search
  // form; a stored code also by its key (it may have been indexed when it
  // was created — a file code's key is never indexed once it is shared).
  const numberHolders = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, value: string, code: string) =>
    map.set(value, (map.get(value) ?? new Set()).add(code));
  for (const code of new Set([...inFile, ...stored])) {
    const key = eightDigitKey(code);
    const number = normalizeOem(code);
    if (key) add(holders, key, code);
    if (number) {
      add(holders, number, code);
      add(numberHolders, number, code);
    }
    if (key && stored.has(code)) add(numberHolders, key, code);
  }
  for (const code of inFile) {
    const key = eightDigitKey(code);
    if (key && holders.get(key)!.size === 1) out.searchKeys.set(code, key);
    if (stored.has(code)) continue;
    const same = [...(numberHolders.get(normalizeOem(code)) ?? [])]
      .filter((c) => c !== code)
      .sort();
    if (same.length) out.sameSearchNumber.set(code, same);
  }
  return out;
}

const quoted = (codes: string[]) => codes.map((c) => `"${c}"`).join(', ');

function issue(
  row: ParsedRow,
  severity: ImportIssue['severity'],
  code: string,
  message: string,
): ImportIssue {
  return {
    line: row.line,
    code1c: row.code1c,
    kind: 'data',
    severity,
    code,
    field: 'code1c',
    message,
  };
}

export const keySharedIssue = (row: ParsedRow, shared: KeyShare): ImportIssue =>
  issue(
    row,
    'warning',
    'code_key_shared',
    `code_1c "${row.code1c}" shares the 8-digit key ${shared.key} with ${[
      shared.fileCodes.length ? `${quoted(shared.fileCodes)} in this file` : '',
      shared.storedCodes.length
        ? `the stored position(s) ${quoted(shared.storedCodes)}`
        : '',
    ]
      .filter(Boolean)
      .join(' and ')}${
      shared.possibleRenameOf.length
        ? ` — possibly ${quoted(shared.possibleRenameOf)} renamed in 1C`
        : ''
    }. It is created as a position of its own: the import finds positions by their exact code_1c only and never renames or merges one — an operator decides`,
  );

export const sameSearchNumberIssue = (
  row: ParsedRow,
  others: string[],
): ImportIssue =>
  issue(
    row,
    'warning',
    'oem_index_shared',
    `code_1c "${row.code1c}" has the same search number as ${quoted(others)} — they stay separate positions, but a buyer search finds them together and a sync-inventory upload of this article reaches only one of them`,
  );
