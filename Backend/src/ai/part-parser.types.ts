// src/ai/part-parser.types.ts
//
// Shared metadata shape produced by the hybrid part-text parser.
// Every layer (rule-based, AI fallback, sanitizer, DB save, search, display)
// uses this exact structure — no mixed fields.

/** One vehicle a part fits: canonical model plus ITS OWN canonical brand. */
export interface ParsedVehicle {
  /** Canonical brand owning this model, or null when unresolvable. */
  brand: string | null;
  /** Canonical model name — e.g. "Cobalt". */
  model: string;
}

/**
 * How the seller labeled the part number. We NEVER infer this from the number
 * itself or from the LLM — only from an explicit "GM"/"OEM" label next to the
 * value. An unlabeled number (bare digits, "Артикул", "Part No.") stays UNKNOWN
 * so it remains searchable as BOTH a GM and an OEM number.
 */
export type PartNumberType = 'GM' | 'OEM' | 'UNKNOWN';

export interface ParsedPartMetadata {
  /** Part name only — e.g. "Фильтр масляный". Never contains brand/model/price/OEM. */
  title: string | null;
  /** Extra info — condition, side, quantity, etc. e.g. "Оригинал". */
  description: string | null;
  /** Canonical brand name — e.g. "Chevrolet". */
  brand: string | null;
  /** Canonical model names — e.g. ["Cobalt", "Gentra"]. */
  models: string[];
  /**
   * Deduplicated (brand, model) pairs the part fits — the UNION of title and
   * description mentions, each model paired with its own brand (cross-brand
   * listings keep every model under the correct brand). Optional so legacy
   * object literals stay valid; the sanitizer/parser service always fill it.
   */
  vehicles?: ParsedVehicle[];
  /**
   * True when the listing says the part fits EVERY vehicle ("Универсальный",
   * "Для всех автомобилей", …). Highest priority: when set, vehicles/models
   * are empty and no per-vehicle links must be created.
   */
  isUniversal?: boolean;
  /**
   * The seller's part number as a digit string — e.g. "96535062". This is the
   * RAW value regardless of label; `part_number_type` records whether the seller
   * called it GM, OEM, or left it unlabeled. Kept named `gm_number` for backward
   * compatibility with existing persistence (Product.gmNumber unique key).
   */
  gm_number: string | null;
  /**
   * How the seller labeled `gm_number`. Optional so legacy object literals stay
   * valid; the parser/sanitizer always fill it. Defaults to 'UNKNOWN' — an
   * unlabeled number is NEVER guessed to be GM or OEM.
   */
  part_number_type?: PartNumberType;
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

/** How a final result was produced — useful for logging/metrics. 'wizard' means
 *  the metadata was assembled from explicit step-by-step bot input (no parsing). */
export type ParseSource =
  'structured' | 'rule-based' | 'ai-fallback' | 'mock' | 'wizard';

export interface ParseOutcome extends ParsedPartMetadata {
  source: ParseSource;
  confidence: number;
  /** Always present on a final outcome (empty when universal or none found). */
  vehicles: ParsedVehicle[];
  /** Always present on a final outcome. */
  isUniversal: boolean;
  /** Always present on a final outcome (defaults to 'UNKNOWN'). */
  part_number_type: PartNumberType;
}
