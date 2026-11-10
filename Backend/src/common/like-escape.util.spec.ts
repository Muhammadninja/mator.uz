// INFO-9: search text is matched literally, not as a LIKE pattern.

import { escapeLike } from './like-escape.util';
import { partTextWhere } from '../catalog/parts/parts.service';
import { matchesWhere } from '../catalog/compatibility/where-eval.test-util';

describe('escapeLike', () => {
  it('escapes both wildcards and the escape character', () => {
    expect(escapeLike('50%_off')).toBe('50\\%\\_off');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('leaves ordinary text, Cyrillic and article numbers alone', () => {
    for (const text of ['Тормозные колодки', '96535062', 'SP-1362', '5W-30']) {
      expect(escapeLike(text)).toBe(text);
    }
  });

  it('the buyer search hands Prisma the escaped title term', () => {
    const where = partTextWhere('%') as {
      OR: { title?: { contains: string } }[];
    };
    expect(where.OR[0].title!.contains).toBe('\\%');
  });

  it('normal searches keep matching', () => {
    const part = {
      title: 'Колодки тормозные передние',
      oemNumbers: [],
      gmNumbers: [],
    };
    // The in-memory evaluator treats `contains` literally, as PostgreSQL now will.
    expect(matchesWhere(part, partTextWhere('колодки'))).toBe(true);
  });
});
