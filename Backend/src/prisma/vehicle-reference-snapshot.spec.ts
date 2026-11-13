import {
  parseReferenceSnapshot,
  SnapshotFormatError,
} from './vehicle-reference-snapshot';

const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    captured_at: '2026-11-12T10:00:00+05:00',
    makes: [
      {
        id: 'chevrolet',
        name: 'Chevrolet',
        is_active: true,
        coming_soon: false,
        sort_order: 0,
      },
    ],
    models: [
      {
        id: 'cobalt',
        make_id: 'chevrolet',
        name: 'Cobalt',
        sort_order: 0,
        year_from: null,
        year_to: null,
        body_type: null,
      },
    ],
    ...over,
  });

describe('parseReferenceSnapshot', () => {
  it('maps the SQL output onto the planner snapshot', () => {
    expect(parseReferenceSnapshot(`${doc()}\n`)).toEqual({
      capturedAt: '2026-11-12T10:00:00+05:00',
      snapshot: {
        makes: [
          {
            id: 'chevrolet',
            name: 'Chevrolet',
            isActive: true,
            comingSoon: false,
            sortOrder: 0,
          },
        ],
        models: [
          {
            id: 'cobalt',
            makeId: 'chevrolet',
            name: 'Cobalt',
            sortOrder: 0,
            yearFrom: null,
            yearTo: null,
            bodyType: null,
            variantOfModelId: null,
          },
        ],
      },
    });
  });

  it.each([
    ['not JSON', 'id | name', 'not valid JSON'],
    ['an array', '[]', 'expected one JSON object'],
    ['no makes', doc({ makes: [], models: [] }), 'has no makes'],
    [
      'a wrongly typed field',
      doc({
        makes: [
          {
            id: 'chevrolet',
            name: 'Chevrolet',
            is_active: 't',
            coming_soon: false,
            sort_order: 0,
          },
        ],
      }),
      '"is_active" must be true/false',
    ],
    [
      'a missing field',
      doc({
        models: [
          { id: 'cobalt', make_id: 'chevrolet', name: 'Cobalt', sort_order: 0 },
        ],
      }),
      '"year_from" must be an integer',
    ],
    [
      'a duplicate id',
      doc({
        makes: [
          {
            id: 'chevrolet',
            name: 'Chevrolet',
            is_active: true,
            coming_soon: false,
            sort_order: 0,
          },
          {
            id: 'chevrolet',
            name: 'Chevy',
            is_active: true,
            coming_soon: false,
            sort_order: 1,
          },
        ],
      }),
      'make id "chevrolet" appears twice',
    ],
    [
      'a model of an unknown make',
      doc({
        models: [
          {
            id: 'x5',
            make_id: 'bmw',
            name: 'X5',
            sort_order: 0,
            year_from: null,
            year_to: null,
            body_type: null,
          },
        ],
      }),
      'names make "bmw", which is not in the snapshot',
    ],
    [
      'a variant of a model that is not in the snapshot',
      doc({
        models: [
          {
            id: 'nexia-3',
            make_id: 'chevrolet',
            name: 'Nexia 3',
            sort_order: 0,
            year_from: 2016,
            year_to: 2022,
            body_type: null,
            variant_of_model_id: 'nexia',
          },
        ],
      }),
      'is a variant of "nexia", which is not in the snapshot',
    ],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parseReferenceSnapshot(raw)).toThrow(SnapshotFormatError);
    expect(() => parseReferenceSnapshot(raw)).toThrow(message);
  });
});

describe('parseReferenceSnapshot: generation rows', () => {
  const model = (over: Record<string, unknown>) => ({
    make_id: 'chevrolet',
    sort_order: 0,
    year_from: null,
    year_to: null,
    body_type: null,
    ...over,
  });
  const raw = (models: unknown[]) =>
    JSON.stringify({
      makes: [
        {
          id: 'chevrolet',
          name: 'Chevrolet',
          is_active: true,
          coming_soon: false,
          sort_order: 0,
        },
      ],
      models,
    });

  it('reads variant_of_model_id, and treats it as null where the column predates the migration', () => {
    const { snapshot } = parseReferenceSnapshot(
      raw([
        model({ id: 'nexia', name: 'Nexia' }),
        model({ id: 'nexia-3', name: 'Nexia 3', variant_of_model_id: 'nexia' }),
      ]),
    );
    expect(snapshot.models.map((m) => [m.id, m.variantOfModelId])).toEqual([
      ['nexia', null],
      ['nexia-3', 'nexia'],
    ]);
  });
});
