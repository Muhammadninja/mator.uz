/**
 * Reads a Driver's Village 1C export into rows of string cells — either the
 * file saved from Excel as "Text (Tab delimited)" or 1C's own ";"-delimited
 * export (dv_parts_<date>.txt). No dependencies: decoding uses the WHATWG
 * TextDecoder built into Node, parsing is a small state machine.
 *
 * ── Delimiter ──
 * Decided by the header row's structure (detectDelimiter), never by the file
 * name: the delimiter that splits the header into the required columns. A
 * header that works with both is ambiguous and the file is refused.
 *
 * ── Encoding ──
 * Excel writes this format in the machine's legacy code page, NOT UTF-8:
 * Excel for Mac → Mac Cyrillic with bare-CR line endings (the current Driver's
 * Village file), Excel for Windows → Windows-1251 with CRLF. Both are single-
 * byte encodings that agree on lowercase Cyrillic (0xE0–0xFE) and differ on
 * uppercase: Mac Cyrillic puts А–Я at 0x80–0x9F, Windows-1251 at 0xC0–0xDF.
 * Detection therefore counts bytes in those two ranges. The result is always
 * reported, and `--encoding` overrides it. 1C's ";" export is UTF-8 with a
 * BOM and CRLF line endings.
 *
 * ── Quoting ──
 * Excel quotes a field that contains the delimiter, a line break or a quote:
 * the field starts with `"`, ends at `"` followed by the delimiter or a line
 * break, and a quote inside it is doubled. The Excel file relies on this (a
 * name with an embedded tab, a model list "TRACKER; TRAVERSE"); 1C's export
 * only has quotes inside names (literal).
 */

export const SUPPORTED_ENCODINGS = [
  'utf-8',
  'x-mac-cyrillic',
  'windows-1251',
] as const;
export type SourceEncoding = (typeof SUPPORTED_ENCODINGS)[number];

export interface DecodedSource {
  text: string;
  encoding: SourceEncoding;
  /** True when the encoding was detected rather than forced. */
  detected: boolean;
}

export function isSupportedEncoding(value: string): value is SourceEncoding {
  return (SUPPORTED_ENCODINGS as readonly string[]).includes(value);
}

/** Decode the raw file bytes (detecting the encoding unless one is forced). */
export function decodeSource(
  bytes: Uint8Array,
  forced?: SourceEncoding,
): DecodedSource {
  if (forced) {
    return { text: decode(bytes, forced), encoding: forced, detected: false };
  }

  // UTF-8 (with or without BOM) is unambiguous: a legacy single-byte file with
  // any Cyrillic is practically never valid UTF-8.
  try {
    return { text: decode(bytes, 'utf-8'), encoding: 'utf-8', detected: true };
  } catch {
    // Not UTF-8 → one of the legacy Cyrillic code pages.
  }

  let macUpper = 0; // 0x80–0x9F: А–Я in Mac Cyrillic, rare punctuation in 1251
  let winUpper = 0; // 0xC0–0xDF: А–Я in Windows-1251, symbols in Mac Cyrillic
  for (const b of bytes) {
    if (b >= 0x80 && b <= 0x9f) macUpper += 1;
    else if (b >= 0xc0 && b <= 0xdf) winUpper += 1;
  }
  const encoding: SourceEncoding =
    macUpper > winUpper ? 'x-mac-cyrillic' : 'windows-1251';
  return { text: decode(bytes, encoding), encoding, detected: true };
}

function decode(bytes: Uint8Array, encoding: SourceEncoding): string {
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  // TextDecoder strips a UTF-8 BOM by default; strip a stray U+FEFF anyway.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** One parsed record with the physical line it started on (1-based). */
export interface TsvRecord {
  line: number;
  cells: string[];
}

export const DELIMITERS = { tab: '\t', semicolon: ';' } as const;
export type DelimiterName = keyof typeof DELIMITERS;
export type Delimiter = (typeof DELIMITERS)[DelimiterName];

export type DelimiterDetection =
  | { ok: true; name: DelimiterName; delimiter: Delimiter }
  | { ok: false; reason: string };

/**
 * The delimiter of the export, from its header row: the candidate (tab, ";")
 * whose split satisfies `isHeader` (all required columns, no conflicts).
 * Both → ambiguous, refused. Only one candidate present at all → that one
 * (the header check then names the missing columns). Neither → refused.
 */
export function detectDelimiter(
  text: string,
  isHeader: (cells: string[]) => boolean,
): DelimiterDetection {
  const header = text.split(/\r\n|\r|\n/).find((l) => l.trim() !== '') ?? '';
  const names = (Object.keys(DELIMITERS) as DelimiterName[]).filter((n) =>
    header.includes(DELIMITERS[n]),
  );
  const pick = (name: DelimiterName): DelimiterDetection => ({
    ok: true,
    name,
    delimiter: DELIMITERS[name],
  });
  if (names.length === 0)
    return {
      ok: false,
      reason:
        'The header row is split by neither tabs nor ";" — expected the tab-delimited Excel text or the ";"-delimited 1C export.',
    };
  const valid = names.filter((n) =>
    isHeader(parseDelimited(header, DELIMITERS[n])[0]?.cells ?? []),
  );
  if (valid.length > 1)
    return {
      ok: false,
      reason:
        'The header row holds the required columns both when split by tabs and when split by ";" — the file is ambiguous. Export it with one delimiter only.',
    };
  if (valid.length === 1) return pick(valid[0]);
  if (names.length === 1) return pick(names[0]);
  return {
    ok: false,
    reason:
      'Neither tabs nor ";" split the header row into the required columns.',
  };
}

/** Tab-delimited text (Excel). See parseDelimited. */
export function parseTsv(text: string): TsvRecord[] {
  return parseDelimited(text, DELIMITERS.tab);
}

/**
 * Split decoded text into records of cells. Accepts CRLF, LF and bare CR line
 * endings. Records whose every cell is blank are dropped (Excel pads the end of
 * the file; 1C's export ends with a stray BOM). A quote that is not at the
 * start of a field is literal.
 */
export function parseDelimited(
  text: string,
  delimiter: Delimiter,
): TsvRecord[] {
  const records: TsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let atFieldStart = true;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;

  const endCell = () => {
    cells.push(cell);
    cell = '';
    atFieldStart = true;
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) {
      records.push({ line: recordLine, cells });
    }
    cells = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line += 1;
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      quoteLine = line;
      atFieldStart = false;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      cell += ch;
      atFieldStart = false;
    }
  }
  if (inQuotes) {
    // Continuing would silently fold the rest of the file into one cell.
    throw new Error(
      `Unterminated quoted field starting on line ${quoteLine} — the file is malformed.`,
    );
  }
  if (cell !== '' || cells.length > 0) endRecord();

  return records;
}
