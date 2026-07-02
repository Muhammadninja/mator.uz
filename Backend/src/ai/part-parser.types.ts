// src/ai/part-parser.types.ts
//
// Shared metadata shape produced by the hybrid part-text parser.
// Every layer (rule-based, AI fallback, sanitizer, DB save, search, display)
// uses this exact structure — no mixed fields.

export interface ParsedPartMetadata {
  /** Part name only — e.g. "Фильтр масляный". Never contains brand/model/price/OEM. */
  title: string | null;
  /** Extra info — condition, side, quantity, etc. e.g. "Оригинал". */
  description: string | null;
  /** Canonical brand name — e.g. "Chevrolet". */
  brand: string | null;
  /** Canonical model names — e.g. ["Cobalt", "Gentra"]. */
  models: string[];
  /** OEM/GM number as a digit string — e.g. "96535062". */
  gm_number: string | null;
  /** Numeric price without currency — e.g. 25000. */
  price: number | null;
}

/** Rule-based parse output: metadata plus a confidence score in [0, 1]. */
export interface RuleBasedResult extends ParsedPartMetadata {
  confidence: number;
  /**
   * When true, the title is already the seller's verbatim first paragraph and
   * must NOT be rewritten by the sanitizer (no make/model/OEM/condition
   * stripping). Set by the multi-paragraph fallback path.
   */
  preserveTitle?: boolean;
}

/** How a final result was produced — useful for logging/metrics. */
export type ParseSource = 'structured' | 'rule-based' | 'ai-fallback' | 'mock';

export interface ParseOutcome extends ParsedPartMetadata {
  source: ParseSource;
  confidence: number;
}
