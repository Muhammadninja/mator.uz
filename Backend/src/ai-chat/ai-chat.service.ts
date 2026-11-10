import { HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { SendMessageDto } from './dto/send-message.dto';
import { RagSearchService, StockItem } from './rag-search.service';
import { SourcingService } from '../sourcing/sourcing.service';
import { AdminEventsGateway } from '../events/admin-events.gateway';
import {
  CANONICAL_RESPONSES,
  detectConversationLanguage,
  makesUnsupportedPromise,
  type SupportedLang,
} from '../common/i18n.util';
import { randomUUID } from 'crypto';
import type { VehicleCompatContext } from '../catalog/parts/part.presenter';
import {
  toVehicleFitContext,
  VEHICLE_FIT_SELECT,
} from '../catalog/compatibility/vehicle-fitment';
import { PrismaService } from '../prisma/prisma.service';
import { sourcingPartKey, sourcingVehicleKey } from '../sourcing/sourcing-keys';
import { SourcingConfig } from '../sourcing/sourcing.config';
import { SourcingLifecycleService } from '../sourcing/sourcing-lifecycle.service';
import {
  SourcingLeaseLostError,
  SourcingRequestService,
  sourcingPayloadHash,
  type NewSourcingItem,
  type RequestClaim,
} from '../sourcing/sourcing-request.service';

/** Intent on the response. The LLM only ever returns the first three. */
export type ChatIntent =
  | 'SEARCH_PART'
  | 'CREATE_SOURCING_TICKET'
  | 'GENERAL_QUESTION'
  | 'FOUND_IN_STOCK'
  | 'SOURCING_AUTH_REQUIRED'
  | 'SOURCING_UNAVAILABLE'
  | 'PARTS_RESULT';

export type ChatPreference = 'cheapest' | 'oem' | 'fastest' | null;

export interface ExtractedData {
  brand: string | null;
  model: string | null;
  year: string | null;
  vin: string | null;
  part_name: string | null;
  preference: ChatPreference;
}

export type ChatPartStatus =
  | 'FOUND_IN_STOCK'
  | 'TICKET_CREATED'
  | 'AUTH_REQUIRED'
  | 'NEEDS_CLARIFICATION'
  | 'UNAVAILABLE';

/** The outcome for one requested part. */
export interface ChatPart {
  part_name: string;
  status: ChatPartStatus;
  items?: StockItem[];
  ticket_id?: string;
}

/** Structured envelope returned to the client (and forwarded to mator-admin). */
export interface ChatResponse {
  reply_text: string;
  intent: ChatIntent;
  extracted_data: ExtractedData;
  /** One entry per requested part, none dropped. Empty for a plain question. */
  parts: ChatPart[];
  /** True only when `parts` covers everything the customer asked for. */
  all_parts_accounted: boolean;
  /** The garage vehicle matches were checked against, when there was one. */
  selected_vehicle: { id: string; label: string } | null;
  /** Single-part replies keep these for installed apps. */
  items?: StockItem[];
  ticket_id?: string;
}

/** What the controller verified. Nothing here comes from the request body. */
export interface ChatRequestContext {
  userId: string | null;
  idempotencyKey: string | null;
  selectedVehicleId: string | null;
}

/** The model's reading of one message, before matching. */
interface Classified {
  reply_text: string;
  intent: 'SEARCH_PART' | 'CREATE_SOURCING_TICKET' | 'GENERAL_QUESTION';
  extracted_data: ExtractedData;
  parts: { part_name: string; clarification_question: string | null }[];
  all_parts_accounted: boolean;
}

interface SelectedVehicle {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  year: number;
  vin: string | null;
  fit: VehicleCompatContext;
}

type RawClassification = Partial<Omit<Classified, 'parts'>> & {
  parts?: { part_name?: unknown; clarification_question?: unknown }[];
};

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Cheap, fast triage tier — the right Claude model for high-volume structured
// extraction (Opus, used by the AI advisor, would be overkill here). Low
// temperature keeps the field extraction deterministic.
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.2;
/** Another worker took the request over; one fresh look is enough. */
const MAX_LEASE_RETRIES = 1;

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
    configService: ConfigService,
    private readonly rag: RagSearchService,
    private readonly sourcing: SourcingService,
    private readonly adminEvents: AdminEventsGateway,
    private readonly prisma: PrismaService,
    private readonly requests: SourcingRequestService,
    private readonly lifecycle: SourcingLifecycleService,
    private readonly config: SourcingConfig,
  ) {
    const apiKey = configService.get<string>('ANTHROPIC_API_KEY');
    // Bounded, so the server answers before the app's timeout.
    this.client = apiKey
      ? new Anthropic({ apiKey, timeout: this.config.llmTimeoutMs, maxRetries: 1 })
      : null;
    if (!this.client) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI chat is disabled');
    }
  }

  async processUserMessage(
    dto: SendMessageDto,
    context: ChatRequestContext = { userId: null, idempotencyKey: null, selectedVehicleId: null },
    leaseRetries = 0,
  ): Promise<ChatResponse> {
    const vehicle = await this.loadSelectedVehicle(context);
    const payloadHash = sourcingPayloadHash(dto.message, vehicle?.id ?? null, dto.vin);

    // A guest's request can't create anything, so there's nothing to deduplicate.
    let claim: Extract<RequestClaim, { kind: 'owner' }> | null = null;
    if (context.userId && context.idempotencyKey) {
      const claimed = await this.requests.claim({
        userId: context.userId,
        idempotencyKey: context.idempotencyKey,
        payloadHash,
        vehicleId: vehicle?.id ?? null,
      });
      if (claimed.kind === 'replay') return claimed.response as ChatResponse;
      claim = claimed;
    }

    try {
      const classified = await this.classify(dto, vehicle);
      return await this.orchestrate(classified, dto, context, vehicle, claim, payloadHash);
    } catch (err) {
      if (claim && !(err instanceof SourcingLeaseLostError)) {
        // Nothing committed, so a retry must be free to run again.
        await this.requests.release(claim).catch(() => undefined);
      }
      if (err instanceof SourcingLeaseLostError) {
        // Another worker took this over: its result is the result. Bounded, so
        // repeated losses cannot keep calling the model.
        if (leaseRetries >= MAX_LEASE_RETRIES) {
          throw new ServiceUnavailableException('AI chat is temporarily unavailable');
        }
        return this.processUserMessage(dto, context, leaseRetries + 1);
      }
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `Sourcing orchestration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException('AI chat is temporarily unavailable');
    }
  }

  /** Only the caller's own, undeleted vehicle. Anything else is treated as none. */
  private async loadSelectedVehicle(context: ChatRequestContext): Promise<SelectedVehicle | null> {
    if (!context.userId || !context.selectedVehicleId) return null;
    const row = await this.prisma.vehicle.findFirst({
      where: { id: context.selectedVehicleId, userId: context.userId, deletedAt: null },
      select: { ...VEHICLE_FIT_SELECT, id: true, vin: true },
    });
    if (!row) return null;
    const make = row.make?.name ?? null;
    const model = row.model?.name ?? null;
    return {
      id: row.id,
      label: [make, model, row.year].filter(Boolean).join(' '),
      make,
      model,
      year: row.year,
      vin: row.vin,
      fit: toVehicleFitContext(row),
    };
  }

  /** Decide an outcome for every requested part, then commit any tickets at once. */
  private async orchestrate(
    classified: Classified,
    dto: SendMessageDto,
    context: ChatRequestContext,
    selected: SelectedVehicle | null,
    claim: Extract<RequestClaim, { kind: 'owner' }> | null,
    payloadHash: string,
  ): Promise<ChatResponse> {
    const lang = detectConversationLanguage(
      dto.message,
      (dto.history ?? []).filter((h) => h.role === 'user').map((h) => h.content),
    );

    if (classified.intent === 'GENERAL_QUESTION' || classified.parts.length === 0) {
      if (claim) await this.requests.release(claim);
      return {
        reply_text: makesUnsupportedPromise(classified.reply_text)
          ? CANONICAL_RESPONSES.ASK_PART[lang]
          : classified.reply_text,
        intent: 'GENERAL_QUESTION',
        extracted_data: classified.extracted_data,
        parts: [],
        all_parts_accounted: false,
        selected_vehicle: selected ? { id: selected.id, label: selected.label } : null,
      };
    }

    // A car named in the message wins over the one selected in the app.
    const vehicle = this.namesAnotherCar(classified.extracted_data, selected) ? null : selected;
    const extracted: ExtractedData = vehicle
      ? {
          ...classified.extracted_data,
          brand: vehicle.make,
          model: vehicle.model,
          year: String(vehicle.year),
          vin: classified.extracted_data.vin ?? vehicle.vin,
        }
      : classified.extracted_data;
    const vehicleKey = sourcingVehicleKey({
      vehicleId: vehicle?.id ?? null,
      brand: extracted.brand,
      model: extracted.model,
      year: extracted.year,
    });

    const parts: ChatPart[] = [];
    const newItems: NewSourcingItem[] = [];
    const seen = new Map<string, ChatPart>();
    let question: string | null = null;

    for (const { part_name, clarification_question } of classified.parts) {
      if (clarification_question) {
        question ??= clarification_question;
        parts.push({ part_name, status: 'NEEDS_CLARIFICATION' });
        continue;
      }
      const rag = await this.rag.searchInStock(
        { partName: part_name, brand: extracted.brand, model: extracted.model, vehicle: vehicle?.fit },
        lang,
      );
      if (rag.found) {
        parts.push({ part_name, status: 'FOUND_IN_STOCK', items: rag.items });
        continue;
      }
      if (!context.userId || !this.config.ticketsEnabled) {
        parts.push({ part_name, status: this.config.ticketsEnabled ? 'AUTH_REQUIRED' : 'UNAVAILABLE' });
        continue;
      }
      const partKey = sourcingPartKey(part_name);
      const repeated = seen.get(partKey);
      if (repeated) {
        parts.push({ ...repeated, part_name });
        continue;
      }
      const duplicate = await this.sourcing.findOpenDuplicate({
        userId: context.userId,
        partKey,
        vehicleKey,
        since: new Date(Date.now() - this.config.duplicateWindowMs),
      });
      const ticketId = duplicate?.id ?? randomUUID();
      const part: ChatPart = { part_name, status: 'TICKET_CREATED', ticket_id: ticketId };
      seen.set(partKey, part);
      parts.push(part);
      if (!duplicate) {
        newItems.push({
          id: ticketId,
          partName: part_name,
          partKey,
          vehicleKey,
          vehicleId: vehicle?.id ?? null,
          extractedData: { ...extracted, part_name },
        });
      }
    }

    const response = this.buildResponse({
      parts,
      lang,
      question,
      extracted,
      accounted: classified.all_parts_accounted,
      selected: vehicle,
    });

    const hasTicket = parts.some((p) => p.status === 'TICKET_CREATED');
    if (!hasTicket) {
      if (claim) await this.requests.release(claim);
      return response;
    }

    const tickets = await this.requests.commit({
      claim,
      userId: context.userId as string,
      payloadHash,
      vehicleId: vehicle?.id ?? null,
      rawMessage: dto.message,
      items: newItems,
      response,
    });
    for (const ticket of tickets) {
      this.adminEvents.notifyAdminsNewTicket(ticket);
      // Not awaited: a slow Telegram must not delay the reply. Retries come from
      // the lifecycle sweep, which picks up whatever this attempt leaves pending.
      void this.lifecycle.dispatchStaffNotification(ticket.id).catch((err: unknown) =>
        this.logger.error(
          `Staff notification for ${ticket.id} will retry: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    return response;
  }

  private buildResponse(input: {
    parts: ChatPart[];
    lang: SupportedLang;
    question: string | null;
    extracted: ExtractedData;
    accounted: boolean;
    selected: SelectedVehicle | null;
  }): ChatResponse {
    const { parts, lang, question } = input;
    const has = (status: ChatPartStatus) => parts.some((p) => p.status === status);
    const intent: ChatIntent =
      parts.length > 1
        ? 'PARTS_RESULT'
        : has('TICKET_CREATED')
          ? 'CREATE_SOURCING_TICKET'
          : has('AUTH_REQUIRED')
            ? 'SOURCING_AUTH_REQUIRED'
            : has('UNAVAILABLE')
              ? 'SOURCING_UNAVAILABLE'
              : has('FOUND_IN_STOCK')
                ? 'FOUND_IN_STOCK'
                : 'GENERAL_QUESTION';

    // A question must be asked as written, so it replaces the summary.
    const replyText = question && !makesUnsupportedPromise(question)
      ? question
      : CANONICAL_RESPONSES[
          has('TICKET_CREATED')
            ? 'CREATE_SOURCING_TICKET'
            : has('AUTH_REQUIRED')
              ? 'SOURCING_AUTH_REQUIRED'
              : has('UNAVAILABLE')
                ? 'SOURCING_UNAVAILABLE'
                : has('FOUND_IN_STOCK')
                  ? 'FOUND_IN_STOCK'
                  : 'ASK_PART'
        ][lang];

    const single = parts.length === 1 ? parts[0] : undefined;
    return {
      reply_text: replyText,
      intent,
      extracted_data: input.extracted,
      parts,
      all_parts_accounted: input.accounted,
      selected_vehicle: input.selected
        ? { id: input.selected.id, label: input.selected.label }
        : null,
      ...(single?.items ? { items: single.items } : {}),
      ...(single?.ticket_id ? { ticket_id: single.ticket_id } : {}),
    };
  }

  private namesAnotherCar(extracted: ExtractedData, selected: SelectedVehicle | null): boolean {
    if (!selected) return false;
    const differs = (named: string | null, actual: string | null) =>
      !!named && !!actual && !same(named, actual);
    return differs(extracted.brand, selected.make) || differs(extracted.model, selected.model);
  }

  /** Single Claude call → validated {@link ChatResponse} (pre-orchestration). */
  private async classify(
    dto: SendMessageDto,
    vehicle: SelectedVehicle | null,
  ): Promise<Classified> {
    if (!this.client) {
      throw new ServiceUnavailableException('AI chat is not configured');
    }

    try {
      const message = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: this.buildSystemPrompt(),
        messages: this.buildMessages(dto, vehicle),
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
      '  "reply_text": "Short, friendly reply in the user language",',
      '  "intent": "SEARCH_PART" | "CREATE_SOURCING_TICKET" | "GENERAL_QUESTION",',
      '  "extracted_data": {',
      '    "brand": string | null, "model": string | null, "year": string | null,',
      '    "vin": string | null, "part_name": string | null,',
      '    "preference": "cheapest" | "oem" | "fastest" | null',
      '  },',
      '  "parts": [{ "part_name": string, "clarification_question": string | null }],',
      '  "all_parts_accounted": boolean',
      '}',
      '',
      'Behaviour rules (follow strictly):',
      '- Use the FULL conversation history. NEVER ask again for anything the user already gave (brand, model, part, oil grade, etc.) — carry it forward into extracted_data.',
      '- As soon as a specific part is identifiable, set intent to a part request (SEARCH_PART, or CREATE_SOURCING_TICKET when it must be sourced) and proceed. Do NOT keep asking for more details.',
      '- The YEAR, VIN, and exact car model are ALL OPTIONAL. NEVER ask for the year. NEVER ask for the VIN. NEVER ask which model/generation. If the user has not given them, proceed anyway — the search does not need them.',
      '- If a part name AND a brand are present (e.g. "тормозные колодки на Chevrolet"), you have enough: set a part-request intent immediately, do NOT ask a clarifying question.',
      '- Apply these rules identically in Russian, Uzbek and English. Do not become more inquisitive in one language than another.',
      '- Use GENERAL_QUESTION ONLY when no part can be identified at all, or for greetings / advice / off-topic. Ask at most ONE short clarifying question, and only about the part itself (e.g. front vs rear) — never about the vehicle, its year, or its model.',
      '- List EVERY part the customer asked for in "parts", one entry each. "cabin filter and oil filter" is two entries. Never drop one. "part_name" holds the first.',
      '- Set "clarification_question" on a part only when the answer changes which part it is (for example front or rear), written in the user language. The other parts still proceed.',
      '- Set "all_parts_accounted" to true only when "parts" covers everything asked for. If you are unsure, set it to false.',
      '- NEVER promise a response time, and never say a request was submitted or that anyone is checking or will contact the customer. The system confirms requests itself.',
      '',
      'Examples of correct intent:',
      '- "Нужны передние колодки на Chevrolet Cobalt" → part identified (передние колодки) → SEARCH_PART. Do not ask for the year.',
      '- "Malibu uchun old tormoz kolodkalari kerak" → part identified (old tormoz kolodkalari) → SEARCH_PART. Do not ask for the year.',
      '- "У меня Chevrolet Cobalt" (no part) → GENERAL_QUESTION, ask which part they need.',
      '',
      'Write reply_text in the SAME language the user wrote in — Russian or Uzbek, matching their script (Latin or Cyrillic). Keep it short (1-2 sentences).',
      'Use null for any field you cannot confidently extract. Never invent values.',
      'Respond with ONLY the raw JSON object — no markdown, no code fences, no text before or after it.',
    ].join('\n');
  }

  private buildUserContent(dto: SendMessageDto, vehicle: SelectedVehicle | null): string {
    // Surface a client-supplied VIN as an explicit hint; the model still owns
    // extraction, but this anchors the `vin` field when the scanner provided it.
    // The selected car is context only, so a car named in the message still wins.
    return [
      dto.message,
      dto.vin ? `[known VIN: ${dto.vin}]` : null,
      vehicle ? `[selected vehicle: ${vehicle.label}; use it unless the customer names another car]` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Prior turns + the current message. `history` keeps the stateless endpoint
   * context-aware (a vehicle named in an earlier turn is still known when the
   * part is named later). Anthropic requires the first message to be `user`,
   * so any leading assistant turns are dropped.
   */
  private buildMessages(
    dto: SendMessageDto,
    vehicle: SelectedVehicle | null,
  ): Anthropic.MessageParam[] {
    const history: Anthropic.MessageParam[] = (dto.history ?? [])
      .filter((h) => h.content?.trim())
      .map((h) => ({ role: h.role, content: h.content }));
    while (history.length > 0 && history[0].role === 'assistant') history.shift();
    return [...history, { role: 'user', content: this.buildUserContent(dto, vehicle) }];
  }

  /**
   * Parse the model's text into an object. Claude is instructed to return raw
   * JSON, but we defensively strip a ```json fence if one slips through so a
   * stray code block doesn't fail the whole request.
   */
  private parseJson(text: string): RawClassification {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    return JSON.parse(cleaned) as RawClassification;
  }

  /**
   * Defensive normalization: coerce every field and fall back to a safe default
   * rather than let a malformed model response reach the client.
   */
  private normalize(data: RawClassification, dto: SendMessageDto): Classified {
    const extracted = (data.extracted_data ?? {}) as Partial<ExtractedData>;
    const partName = this.str(extracted.part_name);
    const listed = Array.isArray(data.parts) ? data.parts : [];
    const parts = listed.flatMap((p) => {
      const name = this.str(p?.part_name);
      return name ? [{ part_name: name, clarification_question: this.str(p?.clarification_question) }] : [];
    });
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
        part_name: partName ?? parts[0]?.part_name ?? null,
        preference: this.coercePreference(extracted.preference),
      },
      // A reply with only the old single field can't say it covered everything.
      parts: parts.length > 0 ? parts : partName ? [{ part_name: partName, clarification_question: null }] : [],
      all_parts_accounted: parts.length > 0 && data.all_parts_accounted === true,
    };
  }

  private coerceIntent(value: unknown): Classified['intent'] {
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
