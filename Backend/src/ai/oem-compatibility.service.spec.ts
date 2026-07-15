import { lookupOemCompatibility, OemCompatRow } from './oem-compatibility.service';

/** In-memory fake of the minimal Prisma slice the service uses. */
function fakeDb(rowsByOem: Record<string, OemCompatRow[]>) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      oemCompatibility: {
        findMany: async ({ where }: { where: { oemNumber: string } }) => {
          calls.push(where.oemNumber);
          return rowsByOem[where.oemNumber] ?? [];
        },
      },
    },
  };
}

describe('lookupOemCompatibility', () => {
  it('returns verified (brand, model) pairs for a known OEM number', async () => {
    const { db } = fakeDb({
      '93745764': [
        { make: 'Chevrolet', model: 'Cruze' },
        { make: 'Opel', model: 'Astra' },
      ],
    });
    const out = await lookupOemCompatibility(db, '93745764');
    expect(out).toEqual([
      { brand: 'Chevrolet', model: 'Cruze' },
      { brand: 'Opel', model: 'Astra' },
    ]);
  });

  it('returns an empty list when the number has no verified row (no inference)', async () => {
    const { db, calls } = fakeDb({});
    expect(await lookupOemCompatibility(db, '00000000')).toEqual([]);
    // It DID query the table — it does not short-circuit on shape/length.
    expect(calls).toEqual(['00000000']);
  });

  it('returns an empty list for a null/blank number without querying', async () => {
    const { db, calls } = fakeDb({ '1': [{ make: 'Kia', model: 'Rio' }] });
    expect(await lookupOemCompatibility(db, null)).toEqual([]);
    expect(await lookupOemCompatibility(db, '   ')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('canonicalizes make/model through the shared catalog', async () => {
    const { db } = fakeDb({
      '96535062': [{ make: 'шевроле', model: 'кобальт' }],
    });
    const out = await lookupOemCompatibility(db, '96535062');
    expect(out).toEqual([{ brand: 'Chevrolet', model: 'Cobalt' }]);
  });

  it('de-duplicates identical verified pairs', async () => {
    const { db } = fakeDb({
      '111': [
        { make: 'Kia', model: 'Rio' },
        { make: 'Kia', model: 'Rio' },
      ],
    });
    expect(await lookupOemCompatibility(db, '111')).toEqual([
      { brand: 'Kia', model: 'Rio' },
    ]);
  });
});
