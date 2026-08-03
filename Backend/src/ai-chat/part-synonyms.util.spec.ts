import { expandToken } from './part-synonyms.util';

describe('expandToken', () => {
  it('always includes the original token', () => {
    expect(expandToken('колодки')).toContain('колодки');
    expect(expandToken('xyzzy')).toEqual(['xyzzy']);
  });

  it('maps Uzbek-Latin brake terms onto the Russian title form', () => {
    // A customer typing "kolodka" must reach the Russian title "Колодки …".
    expect(expandToken('kolodka')).toContain('колодк');
    // Declined Uzbek form still resolves via the base form.
    expect(expandToken('kolodkalari')).toContain('колодк');
    expect(expandToken('tormoz')).toContain('колодк');
  });

  it('maps English brake terms onto the Russian title form', () => {
    expect(expandToken('pads')).toContain('колодк');
    expect(expandToken('brake')).toContain('тормоз');
  });

  it('maps oil terms across languages', () => {
    expect(expandToken('moy')).toContain('масло');
    expect(expandToken('oil')).toContain('масло');
    expect(expandToken('масло')).toContain('oil');
  });

  it('maps the front/rear positional words', () => {
    expect(expandToken('old')).toContain('передн'); // uz: front
    expect(expandToken('front')).toContain('передн');
    expect(expandToken('orqa')).toContain('задн'); // uz: rear
  });

  it('is symmetric — a Russian token also yields the Uzbek/English forms', () => {
    const forms = expandToken('колодки');
    expect(forms).toEqual(expect.arrayContaining(['kolodka', 'pads', 'tormoz']));
  });

  it('does not cross concepts (oil ≠ brake)', () => {
    expect(expandToken('kolodka')).not.toContain('масло');
    expect(expandToken('oil')).not.toContain('колодк');
  });
});
