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

import { Logger } from '@nestjs/common';

import { ClaudeMcpService } from './claude-mcp.service';
import type { ParseOutcome } from './part-parser.types';
import { sanitizeMetadata } from './part-sanitizer';
import { RULE_CONFIDENCE_THRESHOLD, ruleBasedParse } from './rule-based-parser';

export class PartParserService {
  private readonly logger = new Logger(PartParserService.name);
  private readonly claude: ClaudeMcpService;

  constructor(claude?: ClaudeMcpService) {
    this.claude = claude ?? new ClaudeMcpService();
  }

  /**
   * Parse seller text into canonical, separated metadata.
   * Returns the result plus how it was produced and the rule-based confidence.
   */
  async parse(rawText: string): Promise<ParseOutcome> {
    const ruleResult = ruleBasedParse(rawText);
    const { confidence } = ruleResult;

    // ── High confidence → accept rule-based result, no AI ────────────────────
    if (confidence >= RULE_CONFIDENCE_THRESHOLD) {
      const sanitized = sanitizeMetadata(ruleResult);
      this.logger.debug(
        `rule-based accepted (confidence=${confidence}) for "${truncate(rawText)}"`,
      );
      return { ...sanitized, source: 'rule-based', confidence };
    }

    // ── Low confidence → AI fallback ─────────────────────────────────────────
    this.logger.debug(
      `rule-based low confidence (${confidence}); using AI fallback for "${truncate(rawText)}"`,
    );

    try {
      const aiRaw = await this.claude.parsePartText(rawText);
      const sanitized = sanitizeMetadata(aiRaw);
      const source = this.claude.isLive ? 'ai-fallback' : 'mock';
      return { ...sanitized, source, confidence };
    } catch (error: unknown) {
      // AI failed (timeout, bad JSON, no key). Degrade gracefully to whatever
      // the rules found — sanitized — rather than dropping the listing.
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`AI fallback failed (${msg}); using rule-based result`);
      const sanitized = sanitizeMetadata(ruleResult);
      return { ...sanitized, source: 'rule-based', confidence };
    }
  }
}

function truncate(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
