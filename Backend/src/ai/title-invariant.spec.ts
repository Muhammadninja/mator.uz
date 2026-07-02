// src/ai/title-invariant.spec.ts
//
// Project-wide invariant regression suite:
//   "The seller's title is the source of truth."
//
// Every parser path (structured, rule-based, and the full PartParserService
// orchestration including the AI branch) must return a title that is identical
// to the seller's original title EXCEPT for whitespace normalization (trim +
// collapse duplicate spaces). No path may rewrite, shorten, reconstruct, strip
// tokens from, or re-case the title.

import { PartParserService } from './part-parser.service';
import type { ParsedPartMetadata } from './part-parser.types';
import { ruleBasedParse } from './rule-based-parser';
import { sanitizeMetadata } from './part-sanitizer';
import { parseStructuredCaption } from './structured-parser';

/** The only permitted title transform (must mirror the parsers' behavior). */
function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** First "title unit" of a caption: first paragraph (blank-line separated). */
function sellerFirstParagraph(caption: string): string {
  return normalizeWhitespace(caption.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/)[0]);
}

// A fake AI client that echoes the caption's first paragraph as the title —
// i.e. an AI that obeys the "extractor, not editor" prompt. Used to prove the
// orchestration + sanitizer keep an AI-provided verbatim title intact.
function echoingClaude(caption: string, fields: Partial<ParsedPartMetadata> = {}) {
  return {
    get isLive() {
      return true;
    },
    async parsePartText(): Promise<ParsedPartMetadata> {
      return {
        title: sellerFirstParagraph(caption),
        description: null,
        brand: null,
        models: [],
        gm_number: null,
        price: null,
        ...fields,
      };
    },
  } as unknown as import('./claude-mcp.service').ClaudeMcpService;
}

describe('TITLE INVARIANT — seller title is preserved on every path', () => {
  // Each caption records the expected title. `labeled` captions carry field
  // labels ("Название:") that ONLY the structured parser understands — the
  // rule-based parser (which never sees them in production) keeps them verbatim,
  // so its raw title differs and it is excluded from the rule-based loop.
  const captions: Array<{
    name: string;
    caption: string;
    expectTitle: string; // the final stored title (production path)
    labeled?: boolean;
  }> = [
    {
      name: 'structured labeled (Format 2)',
      caption:
        'Название: Магнитола для Nexia 3\n\nОписание: новая\n\nGM: 96234567\n\nЦена: 450000',
      expectTitle: 'Магнитола для Nexia 3',
      labeled: true,
    },
    {
      name: 'structured positional (Format 1)',
      caption: 'Магнитола для Nexia 3\n\nПроизводство Корея, новая',
      expectTitle: 'Магнитола для Nexia 3',
    },
    {
      name: 'rule-based multi-paragraph fallback',
      caption: 'Магнитола для Nexia 3\n\nПроизводство Корея\n\nсостояние отличное',
      expectTitle: 'Магнитола для Nexia 3',
    },
    {
      name: 'rule-based single line (legacy)',
      caption: 'Фильтр масла Cobalt 96535062 25000 сум',
      expectTitle: 'Фильтр масла Cobalt 96535062 25000 сум',
    },
    {
      name: 'single line with condition + model',
      caption: 'ступица передняя spark matiz правая сторона',
      expectTitle: 'ступица передняя spark matiz правая сторона',
    },
    {
      name: 'extra internal whitespace is normalized only',
      caption: 'Магнитола   BOSCH   для  Nexia 3\n\nновая',
      expectTitle: 'Магнитола BOSCH для Nexia 3',
    },
  ];

  describe('structured parser path', () => {
    for (const { name, caption, expectTitle } of captions) {
      const structured = parseStructuredCaption(caption);
      if (!structured) continue; // caption routes elsewhere; covered below
      it(`preserves the title: ${name}`, () => {
        expect(structured.title).toBe(expectTitle);
      });
    }
  });

  describe('rule-based parser path (raw + sanitized)', () => {
    // Labeled captions never reach the rule-based parser in production (the
    // structured parser handles them first), so their raw title legitimately
    // still carries the label — exclude them from this path's assertions.
    for (const { name, caption, expectTitle, labeled } of captions) {
      if (labeled) continue;
      it(`preserves the title: ${name}`, () => {
        const raw = ruleBasedParse(caption);
        // The rule-based title is the seller's first paragraph, verbatim.
        expect(raw.title).toBe(expectTitle);
        // ...and the sanitizer must not rewrite it either.
        const sanitized = sanitizeMetadata(raw);
        expect(sanitized.title).toBe(expectTitle);
      });
    }
  });

  describe('sanitizer never rewrites an AI/verbatim title', () => {
    const verbatim = 'Тормозной диск Chevrolet Nexia 3 новый 97168181 100000';
    it('keeps the whole title, only detecting fields', () => {
      const out = sanitizeMetadata({
        title: verbatim,
        description: null,
        brand: null,
        models: [],
        gm_number: '97168181',
        price: 100000,
      });
      expect(out.title).toBe(verbatim);
      expect(out.brand).toBe('Chevrolet');
      expect(out.models).toContain('Nexia 3');
    });
  });

  describe('full PartParserService.parse orchestration', () => {
    for (const { name, caption, expectTitle, labeled } of captions) {
      it(`returns the seller title: ${name}`, async () => {
        const parser = new PartParserService(echoingClaude(caption));
        const out = await parser.parse(caption);
        expect(out.title).toBe(expectTitle);
        // For non-labeled captions the stored title equals the seller's first
        // paragraph verbatim (whitespace-only). Labeled captions strip only the
        // field label, which is not part of the seller's title.
        if (!labeled) {
          expect(out.title).toBe(sellerFirstParagraph(caption));
        }
      });
    }

    it('preserves the title even when the AI branch runs and throws (degrades to rules)', async () => {
      // A single-line caption is not the structured format → rule-based fallback
      // → AI throws → degrades to the rule-based result. The title stays the
      // whole seller line, verbatim.
      const caption = 'Фильтр масла Cobalt 96535062 25000 сум';
      const throwing = {
        get isLive() {
          return true;
        },
        async parsePartText(): Promise<ParsedPartMetadata> {
          throw new Error('AI down');
        },
      } as unknown as import('./claude-mcp.service').ClaudeMcpService;

      const parser = new PartParserService(throwing);
      const out = await parser.parse(caption);
      expect(out.source).toBe('rule-based');
      expect(out.title).toBe('Фильтр масла Cobalt 96535062 25000 сум'); // verbatim
    });
  });
});
