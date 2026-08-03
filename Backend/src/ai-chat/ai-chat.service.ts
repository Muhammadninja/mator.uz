import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { SendMessageDto } from './dto/send-message.dto';
import { RagSearchService, StockItem } from './rag-search.service';
import { SourcingService } from '../sourcing/sourcing.service';
import { AdminEventsGateway } from '../events/admin-events.gateway';

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
}

// Canonical Russian replies for the two orchestrated branches. Deterministic
// copy here (rather than the LLM's free-form reply) keeps the funnel UX
// predictable regardless of how the model phrased its answer.
const FOUND_REPLY =
  'Нашёл подходящие товары в наличии — можете выбрать из списка ниже.';
const SOURCING_REPLY =
  'Спасибо за обращение! Этой позиции сейчас нет в нашем каталоге. ' +
  'Наш отдел закупок уже проверяет цены и свяжется с вами в течение 15 минут.';

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

    // From here on part_name is guaranteed → RAG → FOUND_IN_STOCK | CREATE_SOURCING_TICKET.
    try {
      const rag = await this.rag.searchInStock({
        partName: base.extracted_data.part_name,
        brand: base.extracted_data.brand,
        model: base.extracted_data.model,
      });

      if (rag.found) {
        return {
          ...base,
          intent: 'FOUND_IN_STOCK',
          reply_text: FOUND_REPLY,
          items: rag.items,
        };
      }

      // Not in local stock → persist a ticket and notify admins (best effort).
      const ticket = await this.sourcing.createTicket({
        userId: dto.userId ?? null,
        rawMessage: dto.message,
        // Widen the typed extraction to a plain JSON object for jsonb storage
        // (an interface has no index signature, so the cast is required).
        extractedData: base.extracted_data as unknown as Record<string, unknown>,
      });
      this.adminEvents.notifyAdminsNewTicket(ticket);

      return { ...base, intent: 'CREATE_SOURCING_TICKET', reply_text: SOURCING_REPLY };
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
        messages: [{ role: 'user', content: this.buildUserContent(dto) }],
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
      'Analyze the user message to extract vehicle details (brand, model, year, VIN) and required parts.',
      'Respond strictly in JSON format with the following structure:',
      '{',
      '  "reply_text": "User-facing friendly response in Russian",',
      '  "intent": "SEARCH_PART" | "CREATE_SOURCING_TICKET" | "GENERAL_QUESTION",',
      '  "extracted_data": {',
      '    "brand": string | null,',
      '    "model": string | null,',
      '    "year": string | null,',
      '    "vin": string | null,',
      '    "part_name": string | null,',
      '    "preference": "cheapest" | "oem" | "fastest" | null',
      '  }',
      '}',
      'If the user asks for a part (e.g., "самая дешевая колодка на Skoda"), set "intent" to "CREATE_SOURCING_TICKET" so our admins in mator-admin can handle it, and write a polite reply_text stating that our sourcing department is checking prices and will respond within 15 minutes.',
      'reply_text must always be written in Russian.',
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
