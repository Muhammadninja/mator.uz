import { Logger } from '@nestjs/common';
import { ClaudeMcpService } from './claude-mcp.service';
import { PartParserService } from './part-parser.service';
import type { ParsedPartMetadata } from './part-parser.types';

const EMPTY: ParsedPartMetadata = {
  title: null,
  description: null,
  brand: null,
  models: [],
  gm_number: null,
  price: null,
};

// A fake AI client we can assert against without hitting the network.
// `calls` is exposed via a getter so tests read the live count.
function fakeClaude(opts: {
  isLive: boolean;
  result?: ParsedPartMetadata;
  throws?: boolean;
}): { service: ClaudeMcpService; readonly calls: number } {
  let calls = 0;
  const service = {
    get isLive() {
      return opts.isLive;
    },
    async parsePartText(): Promise<ParsedPartMetadata> {
      calls += 1;
      if (opts.throws) throw new Error('AI down');
      return opts.result ?? EMPTY;
    },
  } as unknown as ClaudeMcpService;

  return {
    service,
    get calls() {
      return calls;
    },
  };
}

describe('PartParserService', () => {
  it('accepts the rule-based result and does NOT call AI when confident', async () => {
    const fake = fakeClaude({ isLive: true });
    const parser = new PartParserService(fake.service);

    const out = await parser.parse('Фильтр масла Cobalt оригинал 96535062 25000 сум');

    expect(out.source).toBe('rule-based');
    expect(out.title).toMatch(/фильтр/i);
    expect(out.brand).toBe('Chevrolet');
    expect(out.models).toEqual(['Cobalt']);
    expect(out.gm_number).toBe('96535062');
    expect(out.price).toBe(25000);
    expect(fake.calls).toBe(0); // AI never invoked
  });

  it('falls back to AI when rule-based confidence is low', async () => {
    // The AI HALLUCINATED a vehicle: neither its title/description nor the
    // caption names Cobalt/Chevrolet, so the sanitizer must drop the inferred
    // make/model — only text- or verified-OEM-derived vehicles survive.
    const aiResult: ParsedPartMetadata = {
      title: 'Генератор',
      description: 'Восстановленный',
      brand: 'Chevrolet',
      models: ['Cobalt'],
      gm_number: null,
      price: null,
    };
    const fake = fakeClaude({ isLive: true, result: aiResult });
    const parser = new PartParserService(fake.service);

    // Bare phrase with no gm/price/known-model → low confidence.
    const out = await parser.parse('генератор восстановленный для машины');

    expect(fake.calls).toBe(1);
    expect(out.source).toBe('ai-fallback');
    expect(out.title).toBe('Генератор');
    expect(out.brand).toBeNull();
    expect(out.models).toEqual([]);
    expect(out.vehicles).toEqual([]);
  });

  it('sanitizes AI output: detects fields but preserves the AI-returned title verbatim', async () => {
    const aiResult: ParsedPartMetadata = {
      title: 'Фильтр масляный Cobalt оригинал',
      description: null,
      brand: null,
      models: [],
      gm_number: null,
      price: null,
    };
    const fake = fakeClaude({ isLive: true, result: aiResult });
    const parser = new PartParserService(fake.service);

    const out = await parser.parse('что-то непонятное про фильтр');

    // INVARIANT: the title is preserved verbatim — brand/model are DETECTED
    // from it into the fields, but the title text is not rewritten/shortened.
    expect(out.title).toBe('Фильтр масляный Cobalt оригинал');
    expect(out.brand).toBe('Chevrolet');
    expect(out.models).toEqual(['Cobalt']);
  });

  it('marks source as mock when AI is not live', async () => {
    const fake = fakeClaude({
      isLive: false,
      result: {
        title: 'Генератор',
        description: null,
        brand: null,
        models: [],
        gm_number: null,
        price: null,
      },
    });
    const parser = new PartParserService(fake.service);

    const out = await parser.parse('генератор для авто');
    expect(out.source).toBe('mock');
  });

  it('degrades to the rule-based result if AI throws', async () => {
    const fake = fakeClaude({ isLive: true, throws: true });
    const parser = new PartParserService(fake.service);

    const out = await parser.parse('генератор для авто');
    expect(fake.calls).toBe(1);
    expect(out.source).toBe('rule-based');
    expect(out.title).toMatch(/генератор/i);
  });

  it('returns all-null for junk text without saving a false product', async () => {
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: null,
        description: null,
        brand: null,
        models: [],
        gm_number: null,
        price: null,
      },
    });
    const parser = new PartParserService(fake.service);

    const out = await parser.parse('HShshdh (HShha)');
    expect(out.title).toBeNull();
    expect(out.brand).toBeNull();
    expect(out.models).toEqual([]);
    expect(out.gm_number).toBeNull();
    expect(out.price).toBeNull();
  });

  it('never corrupts the title on a multi-line caption (title = first line only)', async () => {
    // Under the official one-field-per-line format this 3-line caption parses
    // structurally (line 1 = title). It must never merge later lines into the
    // title — regression guard against the old "Магнитола для Производство Корея".
    const fake = fakeClaude({ isLive: true, throws: true });
    const parser = new PartParserService(fake.service);

    const out = await parser.parse(
      'Магнитола для Nexia 3\nПроизводство Корея, новая\nсостояние отличное',
    );

    expect(out.source).toBe('structured');
    expect(out.title).toBe('Магнитола для Nexia 3'); // first line only, verbatim
    expect(out.title).not.toBe('Магнитола для Производство Корея'); // the old bug
    expect(out.brand).toBe('Chevrolet');
    expect(out.models).toEqual(['Nexia 3']);
  });

  it('degrades to a non-corrupting rule-based result for a single-line caption (AI throws)', async () => {
    const fake = fakeClaude({ isLive: true, throws: true });
    const parser = new PartParserService(fake.service);

    const out = await parser.parse('Магнитола для Nexia 3 96234567 450000');

    expect(out.source).toBe('rule-based'); // single line → fallback
    expect(out.title).toBe('Магнитола для Nexia 3 96234567 450000'); // verbatim
  });
});

describe('PartParserService — part-number type (never guessed)', () => {
  it('labels a bare (unlabeled) number as UNKNOWN', async () => {
    const fake = fakeClaude({ isLive: true });
    const parser = new PartParserService(fake.service);
    const out = await parser.parse('Фильтр масла Cobalt 96535062 25000 сум');
    expect(out.gm_number).toBe('96535062');
    expect(out.part_number_type).toBe('UNKNOWN');
  });

  it('labels a GM-marked number as GM', async () => {
    const fake = fakeClaude({ isLive: true });
    const parser = new PartParserService(fake.service);
    const out = await parser.parse('Фильтр масла Cobalt GM 96535062 25000 сум');
    expect(out.part_number_type).toBe('GM');
  });

  it('labels an OEM-marked number as OEM', async () => {
    const fake = fakeClaude({ isLive: true });
    const parser = new PartParserService(fake.service);
    const out = await parser.parse('Фильтр масла Cobalt OEM 96535062 25000 сум');
    expect(out.part_number_type).toBe('OEM');
  });
});

describe('PartParserService — compatibility only from text or verified OEM DB', () => {
  it('does NOT infer make/model from an OEM number alone (no DB match, no text)', async () => {
    // AI hallucinates Cobalt from the number; the caption text has no vehicle.
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: 'Фильтр масляный 96535062',
        description: null,
        brand: 'Chevrolet',
        models: ['Cobalt'],
        gm_number: '96535062',
        price: null,
      },
    });
    // OEM DB returns nothing for this number.
    const parser = new PartParserService(fake.service, async () => []);
    const out = await parser.parse('фильтр масляный номер 96535062');
    expect(out.brand).toBeNull();
    expect(out.models).toEqual([]);
    expect(out.vehicles).toEqual([]);
    expect(out.gm_number).toBe('96535062'); // number preserved, vehicle not
  });

  it('adds compatibility from the verified OEM DB when a row exists', async () => {
    const fake = fakeClaude({ isLive: true });
    // Rule-based path (confident) — title has no vehicle, only the OEM DB does.
    const parser = new PartParserService(fake.service, async (oem) =>
      oem === '96535062'
        ? [
            { brand: 'Chevrolet', model: 'Cruze' },
            { brand: 'Opel', model: 'Astra' },
          ]
        : [],
    );
    const out = await parser.parse('Фильтр масляный 96535062 25000 сум');
    expect(out.gm_number).toBe('96535062');
    expect(out.vehicles).toEqual([
      { brand: 'Chevrolet', model: 'Cruze' },
      { brand: 'Opel', model: 'Astra' },
    ]);
    expect(out.models).toEqual(['Cruze', 'Astra']);
  });

  it('does NOT look up the OEM DB for a GM-labeled number (a GM number is not an OEM)', async () => {
    const fake = fakeClaude({ isLive: true });
    let lookedUp = false;
    const parser = new PartParserService(fake.service, async () => {
      lookedUp = true;
      return [{ brand: 'Chevrolet', model: 'Cruze' }];
    });
    const out = await parser.parse('Фильтр масляный GM 96535062 25000 сум');
    expect(out.part_number_type).toBe('GM');
    expect(lookedUp).toBe(false);
    expect(out.vehicles).toEqual([]);
  });

  it('still honors a vehicle EXPLICITLY named in the text', async () => {
    const fake = fakeClaude({ isLive: true });
    const parser = new PartParserService(fake.service, async () => []);
    const out = await parser.parse('Фильтр масла для Cobalt 96535062 25000 сум');
    expect(out.brand).toBe('Chevrolet');
    expect(out.models).toEqual(['Cobalt']);
  });
});

describe('PartParserService — consumables get no vehicle unless stated or verified', () => {
  it('assigns NO vehicle to engine oil with only an OEM number', async () => {
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: 'Масло моторное 5W-30',
        description: null,
        brand: 'Chevrolet', // hallucinated from the number
        models: ['Cobalt'],
        gm_number: '96535062',
        price: 120000,
      },
    });
    const parser = new PartParserService(fake.service, async () => []);
    const out = await parser.parse('масло моторное 5w-30 артикул 96535062 120000');
    expect(out.brand).toBeNull();
    expect(out.models).toEqual([]);
    expect(out.vehicles).toEqual([]);
  });

  it('assigns a vehicle to a consumable when the text explicitly names it', async () => {
    // This caption (no part number) drops to the AI fallback. The AI echoes the
    // seller's title verbatim (its contract); "Cobalt" is in that text, so the
    // sanitizer detects it from the text — an explicit, allowed source.
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: 'Масло моторное 5W-30 для Cobalt',
        description: null,
        brand: null,
        models: [],
        gm_number: null,
        price: 120000,
      },
    });
    const parser = new PartParserService(fake.service, async () => []);
    const out = await parser.parse('Масло моторное 5W-30 для Cobalt 120000 сум');
    expect(out.models).toEqual(['Cobalt']);
  });

  it('assigns a vehicle to a consumable when the verified OEM DB confirms it', async () => {
    const fake = fakeClaude({ isLive: true });
    const parser = new PartParserService(fake.service, async () => [
      { brand: 'Chevrolet', model: 'Cobalt' },
    ]);
    const out = await parser.parse('Масло моторное 5W-30 96535062 120000 сум');
    expect(out.models).toEqual(['Cobalt']);
  });
});

describe('PartParserService — rejected-AI-compat diagnostics (debug only)', () => {
  let debugSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** All debug lines that report a rejected AI compatibility. */
  const rejectionLines = () =>
    debugSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('AI compatibility rejected'));

  it('logs a rejected AI vehicle at debug (NOT_IN_TEXT_OR_OEM_DATABASE) without changing the result', async () => {
    // AI hallucinated Cobalt from the number; text names no vehicle; OEM DB empty.
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: 'Фильтр масляный 96535062',
        description: null,
        brand: 'Chevrolet',
        models: ['Cobalt'],
        gm_number: '96535062',
        price: 25000,
      },
    });
    const parser = new PartParserService(fake.service, async () => []);
    const out = await parser.parse('фильтр масляный номер 96535062');

    // Result is unaffected by the diagnostic — the vehicle is still dropped.
    expect(out.models).toEqual([]);
    expect(out.brand).toBeNull();
    expect(out.vehicles).toEqual([]);

    // Exactly one rejection line, at debug (never warn), with reason + payloads.
    const lines = rejectionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NOT_IN_TEXT_OR_OEM_DATABASE');
    expect(lines[0]).toContain('Cobalt'); // the rejected model is reported
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses reason NOT_IN_TEXT when no OEM lookup was possible (GM-labeled number)', async () => {
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: 'Фильтр масляный GM 96535062',
        description: null,
        brand: 'Chevrolet',
        models: ['Cobalt'],
        gm_number: '96535062',
        price: 25000,
      },
    });
    // OEM lookup provided but must NOT be consulted for a GM-labeled number.
    const parser = new PartParserService(fake.service, async () => [
      { brand: 'Chevrolet', model: 'Cobalt' },
    ]);
    const out = await parser.parse('фильтр масляный GM 96535062');

    expect(out.models).toEqual([]); // GM number → no OEM lookup, no text match
    const lines = rejectionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NOT_IN_TEXT');
    expect(lines[0]).not.toContain('NOT_IN_TEXT_OR_OEM_DATABASE');
  });

  it('does NOT log when the AI suggestion is confirmed by the text', async () => {
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: 'Фильтр масляный Cobalt',
        description: null,
        brand: 'Chevrolet',
        models: ['Cobalt'],
        gm_number: null,
        price: 25000,
      },
    });
    const parser = new PartParserService(fake.service, async () => []);
    const out = await parser.parse('что-то про фильтр');

    expect(out.models).toEqual(['Cobalt']); // confirmed by the AI title text
    expect(rejectionLines()).toHaveLength(0); // nothing rejected → nothing logged
  });

  it('does NOT log when the AI suggested no compatibility', async () => {
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: 'Фильтр масляный',
        description: null,
        brand: null,
        models: [],
        gm_number: '96535062',
        price: 25000,
      },
    });
    const parser = new PartParserService(fake.service, async () => []);
    await parser.parse('фильтр масляный 96535062');
    expect(rejectionLines()).toHaveLength(0);
  });

  it('does NOT log when the rejected vehicle is recovered by the verified OEM database', async () => {
    const fake = fakeClaude({
      isLive: true,
      result: {
        title: 'Фильтр масляный 96535062',
        description: null,
        brand: 'Chevrolet',
        models: ['Cobalt'],
        gm_number: '96535062',
        price: 25000,
      },
    });
    // The OEM DB independently verifies Cobalt → it is accepted, not rejected.
    const parser = new PartParserService(fake.service, async () => [
      { brand: 'Chevrolet', model: 'Cobalt' },
    ]);
    const out = await parser.parse('фильтр масляный 96535062');
    expect(out.models).toEqual(['Cobalt']);
    expect(rejectionLines()).toHaveLength(0);
  });
});
