// src/ai/part-parser.service.ts
//
// Orchestrates the hybrid part-text pipeline:
//
//   raw text
//     → rule-based extraction (+ confidence)
//     → if confidence >= threshold: accept rule-based result
//     → else: AI fallback
//     → sanitize final output
//     → return canonical { title, description, brand, models, gm_number, price }
//
// The AI fallback is only used when rules are not confident, and even then its
// output goes through the same sanitizer, so the result is always consistent.
//
// Vehicle compatibility can only come from two sources, both verifiable:
//   (a) the listing TEXT (title/description) via the local catalog, and
//   (b) the VERIFIED internal OEM database (lookupOemCompatibility).
// An OEM number NEVER infers make/model on its own, and the LLM's guesses are
// discarded by the sanitizer unless the text independently confirms them.

import { Logger } from '@nestjs/common';

import { ClaudeMcpService } from './claude-mcp.service';
import { classifyPartNumberType } from './part-number';
import type {
  ParsedPartMetadata,
  ParsedVehicle,
  ParseOutcome,
  ParseSource,
} from './part-parser.types';
import { sanitizeMetadata } from './part-sanitizer';
import { RULE_CONFIDENCE_THRESHOLD, ruleBasedParse } from './rule-based-parser';
import { parseStructuredCaption } from './structured-parser';
import { canonicalizeBrand, canonicalizeModel } from './vehicle-catalog';

/**
 * Resolves verified vehicle compatibility for a raw OEM number. Injected so the
 * parser stays DB-agnostic and unit-testable. Must return ONLY rows found in the
 * verified internal OEM database (empty when none). See lookupOemCompatibility.
 */
export type OemLookup = (oemNumber: string) => Promise<ParsedVehicle[]>;

/**
 * Finalize a metadata object into a ParseOutcome with guaranteed
 * vehicles/isUniversal/part_number_type. The part-number type is decided HERE,
 * from the seller's raw caption and the extracted number, so every path
 * (structured, rule-based, AI) classifies it identically — and never guesses the
 * type from the number's shape or from the LLM. If a path already resolved a
 * type (e.g. a structured OEM/GM label), that wins.
 */
function toOutcome(
  meta: ParsedPartMetadata,
  source: ParseSource,
  confidence: number,
  rawText: string,
): ParseOutcome {
  const part_number_type =
    meta.part_number_type ?? classifyPartNumberType(rawText, meta.gm_number);
  return {
    ...meta,
    vehicles: meta.vehicles ?? [],
    isUniversal: meta.isUniversal ?? false,
    part_number_type,
    source,
    confidence,
  };
}

export class PartParserService {
  private readonly logger = new Logger(PartParserService.name);
  private readonly claude: ClaudeMcpService;
  private readonly oemLookup: OemLookup | null;

  constructor(claude?: ClaudeMcpService, oemLookup?: OemLookup) {
    this.claude = claude ?? new ClaudeMcpService();
    // Optional: when absent, no OEM-database compatibility is added (the text is
    // still the other, always-available source). Callers with DB access pass one.
    this.oemLookup = oemLookup ?? null;
  }

  /**
   * Parse seller text into canonical, separated metadata.
   * Returns the result plus how it was produced and the rule-based confidence.
   */
  async parse(rawText: string): Promise<ParseOutcome> {
    // ── Primary path: structured paragraph format ────────────────────────────
    // Title/description are preserved exactly as written; vehicle make/model is
    // detected from the title without modifying it. NOT run through the
    // sanitizer (which would strip brand/model/OEM out of the title).
    const structured = parseStructuredCaption(rawText);
    if (structured) {
      this.logger.debug(
        `structured caption accepted for "${truncate(rawText)}"`,
      );
      return this.withVerifiedOem(toOutcome(structured, 'structured', 1, rawText));
    }

    // ── Fallback: hybrid rule-based + AI pipeline for unstructured captions ───
    const ruleResult = ruleBasedParse(rawText);
    const { confidence } = ruleResult;

    // ── High confidence → accept rule-based result, no AI ────────────────────
    if (confidence >= RULE_CONFIDENCE_THRESHOLD) {
      // The sanitizer preserves the seller's title verbatim on every path
      // (whitespace-normalize only), so no per-call flag is needed.
      const sanitized = sanitizeMetadata(ruleResult);
      this.logger.debug(
        `rule-based accepted (confidence=${confidence}) for "${truncate(rawText)}"`,
      );
      return this.withVerifiedOem(
        toOutcome(sanitized, 'rule-based', confidence, rawText),
      );
    }

    // ── Low confidence → AI fallback ─────────────────────────────────────────
    this.logger.debug(
      `rule-based low confidence (${confidence}); using AI fallback for "${truncate(rawText)}"`,
    );

    try {
      const aiRaw = await this.claude.parsePartText(rawText);
      const sanitized = sanitizeMetadata(aiRaw);
      const source: ParseSource = this.claude.isLive ? 'ai-fallback' : 'mock';
      const outcome = await this.withVerifiedOem(
        toOutcome(sanitized, source, confidence, rawText),
      );
      // Diagnostics only (debug): report AI-suggested vehicles the trust boundary
      // rejected. This reads the final outcome but NEVER changes it or persists.
      this.logRejectedAiCompat(rawText, aiRaw, outcome);
      return outcome;
    } catch (error: unknown) {
      // AI failed (timeout, bad JSON, no key). Degrade gracefully to whatever
      // the rules found — sanitized — rather than dropping the listing.
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`AI fallback failed (${msg}); using rule-based result`);
      const sanitized = sanitizeMetadata(ruleResult);
      return this.withVerifiedOem(
        toOutcome(sanitized, 'rule-based', confidence, rawText),
      );
    }
  }

  /**
   * Merge VERIFIED OEM-database compatibility into an otherwise text-only
   * outcome. This is the only channel by which an OEM number contributes
   * make/model, and only for numbers the seller did NOT label GM: an OEM-labeled
   * or unlabeled (UNKNOWN) number is looked up; a GM-labeled number is not an OEM
   * and is skipped. A no-match returns the outcome unchanged (no inference).
   *
   * A universal-fitment listing is never given specific vehicles — universality
   * wins over any per-vehicle data, so the OEM merge is skipped entirely.
   */
  private async withVerifiedOem(outcome: ParseOutcome): Promise<ParseOutcome> {
    if (!this.oemLookup) return outcome;
    if (outcome.isUniversal) return outcome;
    if (outcome.part_number_type === 'GM') return outcome; // not an OEM number
    const oem = outcome.gm_number;
    if (!oem) return outcome;

    let verified: ParsedVehicle[] = [];
    try {
      verified = await this.oemLookup(oem);
    } catch (error: unknown) {
      // A lookup failure must never fabricate or drop compatibility — degrade to
      // the text-derived result untouched.
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OEM compatibility lookup failed (${msg}); using text-only result`);
      return outcome;
    }
    if (verified.length === 0) return outcome;

    // Union verified pairs with the text-derived ones (text-first order kept).
    const vehicles = [...outcome.vehicles];
    const seen = new Set(vehicles.map((v) => `${v.brand ?? ''} ${v.model}`));
    for (const v of verified) {
      const key = `${v.brand ?? ''} ${v.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        vehicles.push(v);
      }
    }
    const models = [...new Set(vehicles.map((v) => v.model))];
    const brand = outcome.brand ?? vehicles.find((v) => v.brand)?.brand ?? null;
    return { ...outcome, vehicles, models, brand };
  }

  /**
   * DIAGNOSTICS ONLY. Logs (at debug) any make/model the AI SUGGESTED that the
   * trust boundary REJECTED — i.e. a canonical AI model that is NOT in the final
   * outcome (it appeared neither in the listing text nor in the verified OEM
   * database). This measures AI hallucination rate; it NEVER changes the parse
   * result, is NEVER persisted, and is NEVER exposed through any API.
   *
   * Rejected AI guesses are EXPECTED (the sanitizer is doing its job), so this is
   * `debug`, not `warn`. A no-rejection case logs nothing.
   *
   * `rawText` is the only listing identifier available at this layer (a Telegram
   * message id is not threaded down here); it is truncated for the log line.
   */
  private logRejectedAiCompat(
    rawText: string,
    aiRaw: ParsedPartMetadata,
    finalOutcome: ParseOutcome,
  ): void {
    // What the AI suggested, canonicalized to compare on equal footing.
    const suggestedModels = Array.isArray(aiRaw.models)
      ? [...new Set(aiRaw.models.map((m) => canonicalizeModel(String(m).trim())).filter(Boolean))]
      : [];
    if (suggestedModels.length === 0) return; // AI suggested no compatibility

    // Models that survived into the final result (text- or OEM-DB-confirmed).
    const acceptedModels = new Set(finalOutcome.models);
    const rejectedModels = suggestedModels.filter((m) => !acceptedModels.has(m));
    if (rejectedModels.length === 0) return; // every AI suggestion was confirmed

    // Reason: a rejected pair failed the text check; it also failed the OEM-DB
    // check when a lookup was even possible (an OEM/UNKNOWN number was present).
    // A GM-labeled or absent number means only the text check applied.
    const oemLookupApplied =
      Boolean(finalOutcome.gm_number) && finalOutcome.part_number_type !== 'GM';
    const reason = oemLookupApplied ? 'NOT_IN_TEXT_OR_OEM_DATABASE' : 'NOT_IN_TEXT';

    this.logger.debug(
      `AI compatibility rejected (${reason}) — ` +
        `listing="${truncate(rawText)}" ` +
        `ai_suggested=${JSON.stringify({
          brand: canonicalizeBrand(aiRaw.brand ?? null),
          models: suggestedModels,
        })} ` +
        `rejected=${JSON.stringify(rejectedModels)} ` +
        `sanitized=${JSON.stringify({ brand: finalOutcome.brand, models: finalOutcome.models })}`,
    );
  }
}

function truncate(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
