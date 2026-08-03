import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { SendMessageDto } from './dto/send-message.dto';
import { RagSearchService, StockItem } from './rag-search.service';
import { SourcingService } from '../sourcing/sourcing.service';
import { AdminEventsGateway } from '../events/admin-events.gateway';
import { CANONICAL_RESPONSES, detectLanguage } from '../common/i18n.util';

/**
 * Intent on the response. The LLM only ever returns the first three; the
 * orchestration adds FOUND_IN_STOCK when RAG matches local inventory, and
 * forces CREATE_SOURCING_TICKET when it doesn't.
 */
export type ChatIntent =
  | 'SEARCH_PART'
  | 'CREATE_SOURCING_TICKET'
  | 'GENERAL_QUESTION'
  | 'FOUND_IN_STOCK';

export type ChatPreference = 'cheapest' | 'oem' | 'fastest' | null;

export interface ExtractedData {
  brand: string | null;
  model: string | null;
  year: string | null;
  vin: string | null;
  part_name: string | null;
  preference: ChatPreference;
}

/** Structured envelope returned to the client (and forwarded to mator-admin). */
export interface ChatResponse {
  reply_text: string;
  intent: ChatIntent;
  extracted_data: ExtractedData;
  /** Present only when intent is FOUND_IN_STOCK. */
  items?: StockItem[];
  /** Set on CREATE_SOURCING_TICKET — the new or de-duplicated existing ticket. */
  ticket_id?: string;
}

// Cheap, fast triage tier — the right Claude model for high-volume structured
// extraction (Opus, used by the AI advisor, would be overkill here). Low
// temperature keeps the field extraction deterministic.
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.2;

/**
 * AI chat for customer support + part sourcing.
 *
 * Single-shot classifier: it turns a free-text customer message into a
 * structured {@link ChatResponse} so the frontend can render a friendly reply
 * and mator-admin can pick up sourcing tickets. Uses the house Anthropic stack
 * (same @anthropic-ai/sdk + config pattern as ClaudeService), so there's one
 * vendor/key across the backend. The LLM call is isolated behind this service.
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly client: Anthropic | null;

  constructor(
    config: ConfigService,
    private readonly rag: RagSearchService,
    private readonly sourcing: SourcingService,
    private readonly adminEvents: AdminEventsGateway,
  ) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI chat is disabled');
    }
  }

  async processUserMessage(dto: SendMessageDto): Promise<ChatResponse> {
    // 1. LLM extracts structured data + a first-pass intent/reply.
    const base = await this.classify(dto);
    // 2. RAG + sourcing orchestration decides the final intent.
    return this.orchestrate(base, dto);
  }

  /** Run RAG, then either surface in-stock matches or open a sourcing ticket. */
  private async orchestrate(
    base: ChatResponse,
    dto: SendMessageDto,
  ): Promise<ChatResponse> {
    const hasValidPart = Boolean(base.extracted_data.part_name?.trim());

    // If the model wants a ticket but extracted no concrete part, downgrade to a
    // normal dialogue turn — you can't source "nothing". This keeps the
    // invariant that CREATE_SOURCING_TICKET in a response ALWAYS means a real
    // ticket was persisted (with the canonical SLA copy).
    if (base.intent === 'CREATE_SOURCING_TICKET' && !hasValidPart) {
      base.intent = 'GENERAL_QUESTION';
    }

    // No concrete part (or a plain question) → return Claude's free-form reply.
    if (base.intent === 'GENERAL_QUESTION' || !hasValidPart) {
      return base;
    }

    // Reply in the user's language (canonical copy is localized RU / UZ).
    const lang = detectLanguage(dto.message);
    // Non-null past the gate above; keep a typed local for the dedup lookup.
    const partName = base.extracted_data.part_name as string;

    // From here on part_name is guaranteed → RAG → FOUND_IN_STOCK | CREATE_SOURCING_TICKET.
    try {
      const rag = await this.rag.searchInStock({
        partName,
        brand: base.extracted_data.brand,
        model: base.extracted_data.model,
      });

      if (rag.found) {
        return {
          ...base,
          intent: 'FOUND_IN_STOCK',
          reply_text: CANONICAL_RESPONSES.FOUND_IN_STOCK[lang],
          items: rag.items,
        };
      }

      // De-dup: a still-open ticket for the same part (same user when known)
      // in the last 10 min → reuse it. Skip the WS broadcast (and Telegram, once
      // wired) so operators don't get a second copy of the same request.
      const duplicate = await this.sourcing.findRecentDuplicate({
        partName,
        userId: dto.userId ?? null,
      });
      if (duplicate) {
        return {
          ...base,
          intent: 'CREATE_SOURCING_TICKET',
          reply_text: CANONICAL_RESPONSES.CREATE_SOURCING_TICKET[lang],
          ticket_id: duplicate.id,
        };
      }

      // Not in local stock and not a duplicate → persist + notify admins.
      const ticket = await this.sourcing.createTicket({
        userId: dto.userId ?? null,
        rawMessage: dto.message,
        // Widen the typed extraction to a plain JSON object for jsonb storage
        // (an interface has no index signature, so the cast is required).
        extractedData: base.extracted_data as unknown as Record<string, unknown>,
      });
      this.adminEvents.notifyAdminsNewTicket(ticket);

      return {
        ...base,
        intent: 'CREATE_SOURCING_TICKET',
        reply_text: CANONICAL_RESPONSES.CREATE_SOURCING_TICKET[lang],
        ticket_id: ticket.id,
      };
    } catch (err) {
      this.logger.error(
        `Sourcing orchestration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('AI chat is temporarily unavailable');
    }
  }

  /** Single Claude call → validated {@link ChatResponse} (pre-orchestration). */
  private async classify(dto: SendMessageDto): Promise<ChatResponse> {
    if (!this.client) {
      throw new ServiceUnavailableException('AI chat is not configured');
    }

    try {
      const message = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: this.buildSystemPrompt(),
        messages: this.buildMessages(dto),
      });

      const text = message.content.find((block) => block.type === 'text')?.text;
      if (!text) {
        throw new Error('empty completion');
      }
      return this.normalize(this.parseJson(text), dto);
    } catch (err) {
      this.logger.error(
        `AI chat completion failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('AI chat is temporarily unavailable');
    }
  }

  private buildSystemPrompt(): string {
    return [
      'You are the AI Assistant for the MATOR auto-parts platform.',
      'Extract the required part and any vehicle details (brand, model, year, VIN) from the conversation.',
      'Respond strictly in JSON with this structure:',
      '{',
      '  "reply_text": "Short, friendly user-facing reply in Russian",',
      '  "intent": "SEARCH_PART" | "CREATE_SOURCING_TICKET" | "GENERAL_QUESTION",',
      '  "extracted_data": {',
      '    "brand": string | null, "model": string | null, "year": string | null,',
      '    "vin": string | null, "part_name": string | null,',
      '    "preference": "cheapest" | "oem" | "fastest" | null',
      '  }',
      '}',
      '',
      'Behaviour rules (follow strictly):',
      '- Use the FULL conversation history. NEVER ask again for anything the user already gave (brand, model, part, oil grade, etc.) — carry it forward into extracted_data.',
      '- As soon as a specific part is identifiable, set intent to a part request (SEARCH_PART, or CREATE_SOURCING_TICKET when it must be sourced) and proceed. Do NOT keep asking for more details.',
      '- VIN and exact car model are OPTIONAL. Never require them, never repeat a request for them, and if the user declines to share them, proceed with whatever information you have.',
      '- Use GENERAL_QUESTION ONLY when no part can be identified at all, or for greetings / advice / off-topic. Ask at most ONE short clarifying question, and only about the part itself — never about the vehicle.',
      '- For a part request, reply_text should say our sourcing department is checking prices and will respond within 15 minutes.',
      '',
      'reply_text is ALWAYS in Russian and short (1–2 sentences).',
      'Use null for any field you cannot confidently extract. Never invent values.',
      'Respond with ONLY the raw JSON object — no markdown, no code fences, no text before or after it.',
    ].join('\n');
  }

  private buildUserContent(dto: SendMessageDto): string {
    // Surface a client-supplied VIN as an explicit hint; the model still owns
    // extraction, but this anchors the `vin` field when the scanner provided it.
    return dto.vin ? `${dto.message}\n\n[known VIN: ${dto.vin}]` : dto.message;
  }

  /**
   * Prior turns + the current message. `history` keeps the stateless endpoint
   * context-aware (a vehicle named in an earlier turn is still known when the
   * part is named later). Anthropic requires the first message to be `user`,
   * so any leading assistant turns are dropped.
   */
  private buildMessages(dto: SendMessageDto): Anthropic.MessageParam[] {
    const history: Anthropic.MessageParam[] = (dto.history ?? [])
      .filter((h) => h.content?.trim())
      .map((h) => ({ role: h.role, content: h.content }));
    while (history.length > 0 && history[0].role === 'assistant') history.shift();
    return [...history, { role: 'user', content: this.buildUserContent(dto) }];
  }

  /**
   * Parse the model's text into an object. Claude is instructed to return raw
   * JSON, but we defensively strip a ```json fence if one slips through so a
   * stray code block doesn't fail the whole request.
   */
  private parseJson(text: string): Partial<ChatResponse> {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    return JSON.parse(cleaned) as Partial<ChatResponse>;
  }

  /**
   * Defensive normalization: coerce every field and fall back to a safe default
   * rather than let a malformed model response reach the client.
   */
  private normalize(data: Partial<ChatResponse>, dto: SendMessageDto): ChatResponse {
    const extracted = (data.extracted_data ?? {}) as Partial<ExtractedData>;
    return {
      reply_text:
        typeof data.reply_text === 'string' && data.reply_text.trim().length > 0
          ? data.reply_text
          : 'Извините, произошла ошибка. Попробуйте переформулировать запрос.',
      intent: this.coerceIntent(data.intent),
      extracted_data: {
        brand: this.str(extracted.brand),
        model: this.str(extracted.model),
        year: this.str(extracted.year),
        vin: this.str(extracted.vin) ?? dto.vin ?? null,
        part_name: this.str(extracted.part_name),
        preference: this.coercePreference(extracted.preference),
      },
    };
  }

  private coerceIntent(value: unknown): ChatIntent {
    return value === 'SEARCH_PART' || value === 'CREATE_SOURCING_TICKET'
      ? value
      : 'GENERAL_QUESTION';
  }

  private coercePreference(value: unknown): ChatPreference {
    return value === 'cheapest' || value === 'oem' || value === 'fastest' ? value : null;
  }

  private str(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }
}
