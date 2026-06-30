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
    expect(out.brand).toBe('Chevrolet');
  });

  it('sanitizes AI output (model leaked into title gets split out)', async () => {
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

    expect(out.title).toBe('Фильтр масляный');
    expect(out.brand).toBe('Chevrolet');
    expect(out.models).toEqual(['Cobalt']);
    expect(out.description?.toLowerCase()).toContain('оригинал');
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
});
