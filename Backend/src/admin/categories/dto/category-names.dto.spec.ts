// Validation tests for the REQUIRED localized category names — the system
// boundary the admin console writes through. Uses the same
// plainToInstance + validateSync pair the global ValidationPipe applies, so a
// rejection here is a real 400 for the console.

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCategoryDto } from './create-category.dto';
import { UpdateCategoryDto } from './update-category.dto';

const validate = <T extends object>(cls: new () => T, payload: unknown) =>
  validateSync(plainToInstance(cls, payload) as object);

/** The failing property names, so a test asserts WHICH field was rejected. */
const failedFields = (errors: ReturnType<typeof validateSync>) =>
  errors.map((e) => e.property).sort();

const NAMES = {
  nameRu: 'Турбокомпрессоры',
  nameUz: 'Turbokompressorlar',
  nameEn: 'Turbochargers',
};

describe('CreateCategoryDto — localized names', () => {
  it('accepts a body carrying all three names', () => {
    expect(validate(CreateCategoryDto, { ...NAMES })).toHaveLength(0);
  });

  it('does not require the internal `name` — it defaults to nameEn', () => {
    const dto = plainToInstance(CreateCategoryDto, { ...NAMES });
    expect(validateSync(dto as object)).toHaveLength(0);
    expect(dto.name).toBeUndefined();
  });

  it.each([
    ['nameRu', { nameUz: NAMES.nameUz, nameEn: NAMES.nameEn }],
    ['nameUz', { nameRu: NAMES.nameRu, nameEn: NAMES.nameEn }],
    ['nameEn', { nameRu: NAMES.nameRu, nameUz: NAMES.nameUz }],
  ])('rejects a body with %s missing', (field, payload) => {
    expect(failedFields(validate(CreateCategoryDto, payload))).toEqual([field]);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a tab', '\t'],
  ])('rejects %s in any of the three names', (_label, blank) => {
    // Every language is checked with the same blank value, so no field can be
    // validated more strictly than its siblings by accident.
    expect(
      failedFields(validate(CreateCategoryDto, { ...NAMES, nameRu: blank })),
    ).toEqual(['nameRu']);
    expect(
      failedFields(validate(CreateCategoryDto, { ...NAMES, nameUz: blank })),
    ).toEqual(['nameUz']);
    expect(
      failedFields(validate(CreateCategoryDto, { ...NAMES, nameEn: blank })),
    ).toEqual(['nameEn']);
  });

  it('reports EVERY missing name at once, not just the first', () => {
    expect(
      failedFields(validate(CreateCategoryDto, { slug: 'turbo' })),
    ).toEqual(['nameEn', 'nameRu', 'nameUz']);
  });

  it('trims surrounding whitespace off a valid name', () => {
    const dto = plainToInstance(CreateCategoryDto, {
      ...NAMES,
      nameRu: '  Турбокомпрессоры  ',
    });
    expect(validateSync(dto as object)).toHaveLength(0);
    expect(dto.nameRu).toBe('Турбокомпрессоры');
  });

  it('rejects a name over the 160-char column bound', () => {
    expect(
      failedFields(
        validate(CreateCategoryDto, { ...NAMES, nameEn: 'x'.repeat(161) }),
      ),
    ).toEqual(['nameEn']);
  });

  it.each([[42], [null], [{}], [['a']]])(
    'rejects a non-string name (%p)',
    (value) => {
      expect(
        validate(CreateCategoryDto, { ...NAMES, nameUz: value }),
      ).not.toHaveLength(0);
    },
  );
});

describe('UpdateCategoryDto — localized names', () => {
  it('accepts a patch that touches ONE language only', () => {
    expect(validate(UpdateCategoryDto, { nameUz: 'Yangi nom' })).toHaveLength(
      0,
    );
  });

  it('accepts a patch that touches none of them', () => {
    expect(validate(UpdateCategoryDto, { isActive: false })).toHaveLength(0);
  });

  it.each([
    ['nameRu', { nameRu: '' }],
    ['nameUz', { nameUz: '   ' }],
    ['nameEn', { nameEn: '' }],
  ])('refuses to blank %s — the column is NOT NULL', (field, payload) => {
    expect(failedFields(validate(UpdateCategoryDto, payload))).toEqual([field]);
  });

  it('rejects null for a name (clearing is not a valid patch)', () => {
    expect(validate(UpdateCategoryDto, { nameRu: null })).not.toHaveLength(0);
  });
});

/**
 * `nameUz` carries a CONTENT rule its RU/EN siblings do not: the column stores
 * Uzbek in LATIN script, and the mistake that actually happens in the console is
 * a Russian name pasted into the Uzbek field. The alphabet itself is covered
 * exhaustively in common/uzbek-latin.util.spec; these tests prove the DTO
 * WIRING — that the rule fires on POST, fires on PATCH only when the key is
 * present, and reports under `nameUz` with the documented message.
 */
describe('nameUz — Uzbek Latin script validation', () => {
  /** The `isUzbekLatin` constraint messages for `nameUz`, if any fired. */
  const scriptErrors = (errors: ReturnType<typeof validateSync>) =>
    errors
      .filter((e) => e.property === 'nameUz')
      .flatMap((e) => Object.values(e.constraints ?? {}))
      .filter((m) => m.includes('Uzbek Latin'));

  describe('CreateCategoryDto (POST — required AND script-checked)', () => {
    it.each([
      'Tormoz kolodkalari',
      'Tormoz tizimi',
      'Oldingi tormoz kolodkalari',
      'Motor moyi',
      'ABS',
      '4WD ehtiyot qismi',
      "O'zbekiston",
      'Oʻzbekiston',
      'Gʻildirak',
    ])('accepts %p', (nameUz) => {
      expect(validate(CreateCategoryDto, { ...NAMES, nameUz })).toHaveLength(0);
    });

    it.each(['Тормоз колодкалари', 'Тормоз', 'Тест', 'колодки'])(
      'rejects the Cyrillic name %p',
      (nameUz) => {
        const errors = validate(CreateCategoryDto, { ...NAMES, nameUz });
        expect(failedFields(errors)).toEqual(['nameUz']);
        expect(scriptErrors(errors)).toEqual([
          'nameUz must contain only Uzbek Latin characters',
        ]);
      },
    );

    it.each(['Tormoz колодкалari', 'Motor масло', "O'zбек тормоз"])(
      'rejects the half-translated name %p',
      (nameUz) => {
        expect(failedFields(validate(CreateCategoryDto, { ...NAMES, nameUz }))).toEqual(
          ['nameUz'],
        );
      },
    );

    // The script rule must not weaken the presence rule, nor stand in for it:
    // a blank value fails as EMPTY (its own constraint), so the console still
    // gets "cannot be empty" rather than a confusing script complaint.
    it('still reports a blank nameUz as empty, not as a script error', () => {
      const errors = validate(CreateCategoryDto, { ...NAMES, nameUz: '   ' });
      expect(failedFields(errors)).toEqual(['nameUz']);
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      expect(messages).toContain('nameUz is required and cannot be empty');
    });

    it('leaves the Russian and English names unconstrained by the script rule', () => {
      expect(
        validate(CreateCategoryDto, {
          nameRu: 'Тормозные колодки',
          nameUz: 'Tormoz kolodkalari',
          nameEn: 'Brake pads',
        }),
      ).toHaveLength(0);
    });
  });

  describe('UpdateCategoryDto (PATCH — optional, but checked when sent)', () => {
    it('accepts an empty patch', () => {
      expect(validate(UpdateCategoryDto, {})).toHaveLength(0);
    });

    it('accepts a patch that omits nameUz entirely', () => {
      expect(validate(UpdateCategoryDto, { nameRu: 'Тормоза' })).toHaveLength(0);
    });

    it.each(['Tormoz kolodkalari', "O'zbekiston", 'Oʻzbekiston', '4WD ehtiyot qismi'])(
      'accepts the valid patch value %p',
      (nameUz) => {
        expect(validate(UpdateCategoryDto, { nameUz })).toHaveLength(0);
      },
    );

    it('rejects { nameUz: "Тормоз" } — a supplied value must be Latin', () => {
      const errors = validate(UpdateCategoryDto, { nameUz: 'Тормоз' });
      expect(failedFields(errors)).toEqual(['nameUz']);
      expect(scriptErrors(errors)).toEqual([
        'nameUz must contain only Uzbek Latin characters',
      ]);
    });

    it.each(['Tormoz колодкалari', 'Motor масло', "O'zбек тормоз"])(
      'rejects the half-translated patch %p',
      (nameUz) => {
        expect(failedFields(validate(UpdateCategoryDto, { nameUz }))).toEqual([
          'nameUz',
        ]);
      },
    );
  });
});
