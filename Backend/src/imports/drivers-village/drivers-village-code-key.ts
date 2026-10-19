/**
 * The 8-digit key of a code_1c — an ADDITIONAL way to find the stored position
 * of a code that changed in 1C. `96273708`, `96273708 GMB` and `96273708 OEM`
 * all carry the key `96273708`, so a position imported as `96273708` is
 * updated, not duplicated, once the export writes `96273708 GMB`.
 *
 * The key never replaces code_1c: the code is stored verbatim
 * (stocks.source_code, products.source_part_number) and the key is derived
 * from the stored codes on every run — nothing extra is stored. Only stored
 * code_1c values are compared; a stored part number or OEM list (which may
 * still hold an old, wrong value) and the name never are. Pure: no I/O.
 *
 * Also home of the one validity rule of a code_1c (code1cIssue) and of the key
 * evidence rule (keyProvesSamePart), both shared with the Telegram photo flow.
 */
import { normalizeOem } from '../../common/normalize-oem.util';
import { FIELD_LIMITS } from './drivers-village.constants';
import type {
  CodeKeyConflict,
  ImportIssue,
  ParsedRow,
} from './drivers-village.types';

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
  code: 'empty_code_1c' | 'invalid_code_1c' | 'placeholder_code_1c';
  message: string;
}

/**
 * The one validity rule of a code_1c, or null when the code is valid: one
 * token of letters, digits and `._/-`, or an 8-digit article and a marker
 * split by single spaces; at most 64 characters; never one character repeated.
 * The importer checks a row's code with it and the Telegram photo flow a
 * caption's code, so a caption can name exactly the codes an import stores.
 */
export function code1cIssue(code1c: string | null): Code1cIssue | null {
  if (!code1c) return { code: 'empty_code_1c', message: 'code_1c is empty' };
  if (code1c.length > FIELD_LIMITS.code1c)
    return {
      code: 'invalid_code_1c',
      message: `code_1c longer than ${FIELD_LIMITS.code1c} characters`,
    };
  if (!/^[\p{L}\p{N}._/-]+$/u.test(code1c) && !isSpacedArticle(code1c))
    return {
      code: 'invalid_code_1c',
      message: `code_1c "${code1c}" contains whitespace or unsupported characters (a single space is accepted only next to an 8-digit article, as in "96273708 GMB")`,
    };
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
 * An 8-digit article and a marker split by single spaces: "96273708 GMB",
 * "GMB 96273708". Accepted as is (the space kept), because its 8-digit key
 * finds the position stored under the bare article. Any other whitespace in a
 * code_1c is still rejected.
 */
function isSpacedArticle(code: string): boolean {
  return (
    /^[\p{L}\p{N}._/-]+(?: [\p{L}\p{N}._/-]+)+$/u.test(code) &&
    eightDigitKey(code) !== null
  );
}

/** The previous code_1c a file code takes over, found by the key. */
export interface KeyMatch {
  key: string;
  storedCode: string;
}

/** The codes a code shares its key with while it stays a position of its own. */
export interface KeyShare {
  key: string;
  /** Other codes of the file with the key. */
  fileCodes: string[];
  /** Positions stored with the key that this code does not take over. */
  storedCodes: string[];
}

export interface KeyResolution {
  /** code_1c → the stored position it updates (and that takes its code). */
  matches: Map<string, KeyMatch>;
  /** code_1c → its unresolved key: nothing is written for such a code. */
  conflicts: Map<string, Omit<CodeKeyConflict, 'lines'>>;
  /** code_1c → the codes it shares its key with; it is created separately. */
  shared: Map<string, KeyShare>;
  /**
   * code_1c → its key, when no other position of this seller carries that
   * value (as its own key or its normalized code): only then may the key join
   * the code's OEM index. That index also binds the dealer's 1C stock uploads
   * (sync-inventory takes the first catalog part with the article), so a value
   * on two positions would let the stock of one reach the other.
   */
  searchKeys: Map<string, string>;
}

/**
 * Which stored position each code_1c of the file updates. An exact code_1c
 * always wins, as without keys: a code with a stored position of its own
 * updates it, and that position is never a candidate for another code.
 *
 * Eight equal digits alone do not prove one part. The key counts as evidence
 * only between the bare article and the article with a marker: `96273708` ↔
 * `96273708 GMB` (either way). One marker replaced by another (`96273708 GMB`
 * → `96273708 OEM`) or another 1C series (`00-00001431` → `БП-00001431`)
 * proves nothing. A code without a position of its own, per key:
 *   • no stored position it could provably take over → a new position,
 *     created as before; a key shared with other codes is reported, nothing is
 *     merged and the stored positions stay as they are;
 *   • it is the file's only code with the key, exactly one position is stored
 *     with it, and the takeover is provable → that position;
 *   • a provable takeover with rivals (several stored positions or several
 *     codes of the file with the key) → a conflict: none of those codes is
 *     written and no stored position changes.
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
    matches: new Map(),
    conflicts: new Map(),
    shared: new Map(),
    searchKeys: new Map(),
  };
  for (const [key, g] of groups) {
    const unmatched = g.file.filter((c) => !stored.has(c));
    if (unmatched.length === 0) continue;
    const free = g.stored.filter((c) => !inFile.has(c));
    const provable = unmatched.some((u) =>
      free.some((s) => keyProvesSamePart(u, s)),
    );
    if (!provable) {
      if (g.file.length > 1 || free.length > 0)
        for (const code of unmatched)
          out.shared.set(code, {
            key,
            fileCodes: g.file.filter((c) => c !== code),
            storedCodes: [...free].sort(),
          });
    } else if (g.file.length === 1 && g.stored.length === 1) {
      out.matches.set(unmatched[0], { key, storedCode: g.stored[0] });
    } else {
      const conflict = {
        key,
        codes: unmatched,
        storedCodes: [...g.stored].sort(),
      };
      for (const code of unmatched) out.conflicts.set(code, conflict);
    }
  }

  // Who would carry each value after this import: a stored code taken over
  // by a file code is that code's position.
  const takenOver = new Map(
    [...out.matches].map(([code, m]) => [m.storedCode, code]),
  );
  const holders = new Map<string, Set<string>>();
  for (const code of new Set([...inFile, ...stored])) {
    const position = takenOver.get(code) ?? code;
    for (const value of [eightDigitKey(code), normalizeOem(code)])
      if (value)
        holders.set(value, (holders.get(value) ?? new Set()).add(position));
  }
  for (const code of inFile) {
    const key = eightDigitKey(code);
    if (key && holders.get(key)!.size === 1) out.searchKeys.set(code, key);
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

export const keyMatchIssue = (
  row: ParsedRow,
  match: KeyMatch,
  stockId: number,
): ImportIssue =>
  issue(
    row,
    'warning',
    'code_key_match',
    `code_1c "${row.code1c}" has no position of its own: by its 8-digit key ${match.key} it updates the position stored as "${match.storedCode}" (stock ${stockId}), which takes the code "${row.code1c}"`,
  );

export const keyConflictIssue = (
  row: ParsedRow,
  conflict: Omit<CodeKeyConflict, 'lines'>,
): ImportIssue =>
  issue(
    row,
    'error',
    'code_key_conflict',
    `the 8-digit key ${conflict.key} of code_1c "${row.code1c}" is ambiguous — codes in this file without a position of their own: ${quoted(conflict.codes)}; positions stored with this key: ${quoted(conflict.storedCodes)}. Nothing is written for this code and no stored position changes through the key; resolve the codes in 1C or by hand`,
  );

export const keySharedIssue = (row: ParsedRow, shared: KeyShare): ImportIssue =>
  issue(
    row,
    'warning',
    'code_key_shared',
    `code_1c "${row.code1c}" shares the 8-digit key ${shared.key} with ${[
      shared.fileCodes.length ? `${quoted(shared.fileCodes)} in this file` : '',
      shared.storedCodes.length
        ? `the stored position(s) ${quoted(shared.storedCodes)}, which it cannot be proven to be (only the bare article and the article with a marker count as one part)`
        : '',
    ]
      .filter(Boolean)
      .join(
        ' and ',
      )} — it is created as a position of its own; nothing is merged and no other position changes`,
  );
