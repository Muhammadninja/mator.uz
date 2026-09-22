import { decodeSource, parseTsv } from './tsv-reader';

const cells = (text: string) => parseTsv(text).map((r) => r.cells);

describe('decodeSource', () => {
  const sample = 'Амортизатор ПЕРЕДНИЙ шт.';

  it('detects Mac Cyrillic (Excel for Mac "Tab delimited Text")', () => {
    // Mac Cyrillic: А=0x80 … Я=0x9F, а=0xE0 … ю=0xFE, я=0xDF.
    const mac = Buffer.from([
      0x80, 0xec, 0xee, 0xf0, 0xf2, 0xe8, 0xe7, 0xe0, 0xf2, 0xee, 0xf0,
    ]);
    const out = decodeSource(mac);
    expect(out).toMatchObject({
      encoding: 'x-mac-cyrillic',
      detected: true,
      text: 'Амортизатор',
    });
  });

  it('detects Windows-1251 (Excel for Windows)', () => {
    const win = Buffer.from([
      0xcf, 0xc5, 0xd0, 0xc5, 0xc4, 0xcd, 0xc8, 0xc9, 0x20, 0xf8, 0xf2, 0x2e,
    ]);
    expect(decodeSource(win)).toMatchObject({
      encoding: 'windows-1251',
      text: 'ПЕРЕДНИЙ шт.',
    });
  });

  it('prefers UTF-8 (with or without BOM) when the bytes are valid UTF-8', () => {
    expect(decodeSource(Buffer.from(sample, 'utf-8')).text).toBe(sample);
    expect(
      decodeSource(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample)]),
      ).text,
    ).toBe(sample);
  });

  it('honours a forced encoding and rejects bytes that are invalid in it', () => {
    expect(decodeSource(Buffer.from([0x80]), 'x-mac-cyrillic')).toMatchObject({
      text: 'А',
      detected: false,
    });
    expect(() =>
      decodeSource(Buffer.from([0xff, 0xfe, 0xfd]), 'utf-8'),
    ).toThrow();
  });
});

describe('parseTsv', () => {
  it('accepts bare CR, LF and CRLF record separators', () => {
    expect(cells('a\tb\rc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(cells('a\tb\nc\td\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(cells('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps empty cells and drops fully blank records', () => {
    expect(cells('a\t\tc\r\t\t\r\rd\t\t')).toEqual([
      ['a', '', 'c'],
      ['d', '', ''],
    ]);
  });

  it('handles Excel quoting: embedded tab, embedded separator, doubled quote', () => {
    expect(cells('1\t"ПЫЛЬНИК, ШРУС\t"\t2')).toEqual([
      ['1', 'ПЫЛЬНИК, ШРУС\t', '2'],
    ]);
    expect(cells('x\t"TRACKER; TRAVERSE"\ty')).toEqual([
      ['x', 'TRACKER; TRAVERSE', 'y'],
    ]);
    expect(cells('"say ""hi"""\tz')).toEqual([['say "hi"', 'z']]);
    expect(cells('"multi\rline"\tz\rnext')).toEqual([
      ['multi\rline', 'z'],
      ['next'],
    ]);
  });

  it('treats a quote inside an unquoted field as a literal', () => {
    expect(cells('Масло 5"W\tx')).toEqual([['Масло 5"W', 'x']]);
  });

  it('records the physical line each record starts on', () => {
    expect(parseTsv('h\r"a\rb"\r\rc').map((r) => r.line)).toEqual([1, 2, 5]);
  });

  it('fails loudly on an unterminated quote instead of swallowing the file', () => {
    expect(() => parseTsv('a\t"never closed\rb\tc')).toThrow(
      /Unterminated quoted field/,
    );
  });
});
