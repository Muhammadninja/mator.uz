import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AiMessageRole, type Vehicle } from '@prisma/client';
import type Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';
import { prefixedId, IdPrefix } from '../common/ulid.util';
import { isAllowedAssetUrl } from '../common/asset-url.util';
import { RATE_LIMITER, type RateLimiter } from '../redis/rate-limiter.service';
import { RedisKeys } from '../redis/redis.keys';
import { VehicleContext } from './claude.service';
import { CreateAiSessionDto } from './dto/create-session.dto';
import { SendMessageDto } from './dto/send-message.dto';

@Injectable()
export class AiAdvisorService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * Charge one AI message against the user's budget, throwing 429 when spent.
   *
   * Keyed on the USER, not the session or the IP: the cost being bounded is model
   * spend, and a user opening ten sessions must not get ten budgets. Uses the
   * same Redis fixed-window limiter as OTP/login — no second implementation.
   *
   * Called BEFORE the provider request and before the user message is persisted,
   * so a throttled turn costs neither tokens nor a row.
   */
  async assertWithinRateLimit(
    userId: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const result = await this.rateLimiter.consume(
      RedisKeys.rateAiMessage(userId),
      limit,
      windowSeconds,
    );
    if (!result.allowed) {
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message:
            'Too many AI requests. Please wait before sending another message.',
          retry_after: result.retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async createSession(userId: string, dto: CreateAiSessionDto) {
    const vehicle = dto.vehicle_id
      ? await this.loadOwnedVehicle(userId, dto.vehicle_id)
      : null;
    const context = await this.vehicleContext(vehicle);

    const session = await this.prisma.aiSession.create({
      data: {
        id: prefixedId(IdPrefix.AI_SESSION),
        userId,
        vehicleId: vehicle?.id,
        locale: dto.locale,
        entryPoint: dto.entry_point,
      },
    });

    return {
      session_id: session.id,
      vehicle_context: context,
      created_at: session.createdAt.toISOString(),
    };
  }

  async restore(userId: string, sessionId: string) {
    const session = await this.assertSession(userId, sessionId);
    const messages = await this.prisma.aiMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      session_id: session.id,
      messages: messages.map((m) => ({
        message_id: m.id,
        role: m.role.toLowerCase(),
        content: m.content,
        created_at: m.createdAt.toISOString(),
      })),
    };
  }

  /** Ownership check + resolve the session's vehicle and its context. */
  async assertSessionWithVehicle(userId: string, sessionId: string) {
    const session = await this.assertSession(userId, sessionId);
    const vehicle = session.vehicleId
      ? await this.prisma.vehicle.findUnique({
          where: { id: session.vehicleId },
        })
      : null;
    const context = await this.vehicleContext(vehicle);
    return { session, vehicle, context };
  }

  persistUserMessage(sessionId: string, dto: SendMessageDto) {
    // Reject arbitrary external image URLs at ingestion: any image attachment
    // must point at a trusted asset host over HTTPS (same allowlist as avatars),
    // since these URLs are later forwarded to the model to fetch.
    this.assertAttachmentsAllowed(dto.attachments);
    return this.prisma.aiMessage.create({
      data: {
        id: prefixedId(IdPrefix.AI_MESSAGE),
        sessionId,
        role: AiMessageRole.USER,
        content: dto.content,
        clientMessageId: dto.client_message_id,
        attachments: dto.attachments ? (dto.attachments as object) : undefined,
      },
    });
  }

  /**
   * Enforce the trusted-asset-host allowlist on inbound image attachments. A
   * non-image attachment (or one without a url) carries no fetch, so it passes;
   * an image attachment with a disallowed/non-HTTPS url is rejected with the
   * standard validation error.
   */
  private assertAttachmentsAllowed(
    attachments?: Array<{ type?: string; url?: string; mime?: string }>,
  ): void {
    if (!attachments?.length) return;
    for (const a of attachments) {
      if (a.type === 'image' && a.url && !isAllowedAssetUrl(a.url)) {
        throw new BadRequestException(
          'attachment url must be an HTTPS URL on an allowed asset host',
        );
      }
    }
  }

  persistAssistantMessage(
    sessionId: string,
    content: string,
    structured: object,
  ) {
    return this.prisma.aiMessage.create({
      data: {
        id: prefixedId(IdPrefix.AI_MESSAGE),
        sessionId,
        role: AiMessageRole.ASSISTANT,
        content,
        structured,
      },
    });
  }

  /**
   * Build the Claude message list from stored history (images on the latest user
   * turn).
   *
   * Takes the MOST RECENT `historyLimit` rows and replays them oldest-first. The
   * previous implementation took the FIRST N by `createdAt: 'asc'`, which meant a
   * long conversation fed the model its opening messages forever and never the
   * turn the user had just sent.
   */
  async toClaudeMessages(
    sessionId: string,
    historyLimit: number,
  ): Promise<Anthropic.MessageParam[]> {
    const recent = await this.prisma.aiMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: historyLimit,
    });
    const rows = [...recent].reverse();

    return rows.map((m) => {
      const role = m.role === AiMessageRole.ASSISTANT ? 'assistant' : 'user';
      const attachments =
        (m.attachments as Array<{ type?: string; url?: string }> | null) ?? [];
      const images = attachments
        // Defense in depth: only forward image URLs that pass the trusted-host
        // allowlist, so even a legacy/stored row can't smuggle an arbitrary URL
        // to the model.
        .filter((a) => a.type === 'image' && a.url && isAllowedAssetUrl(a.url))
        .map((a) => ({
          type: 'image' as const,
          source: { type: 'url' as const, url: a.url as string },
        }));

      if (role === 'user' && images.length > 0) {
        return {
          role,
          content: [{ type: 'text' as const, text: m.content }, ...images],
        };
      }
      return { role, content: m.content };
    });
  }

  /**
   * The `structured` block attached to an assistant message.
   *
   * `citedItems` is the number of catalogue rows the model's TOOL CALLS actually
   * returned this turn. It drives `grounded`, which tells the client whether the
   * prose is backed by catalogue data or is general advice — the one bit a UI
   * needs to decide whether to render product cards.
   *
   * What this method no longer does is invent suggestions. It previously ran its
   * own Prisma query — the two most recently created parts and the single
   * cheapest service — with NO relation to what the user asked, and reported a
   * hardcoded `confidence: 0.78` over them. Those rows were unpriced by the sales
   * engine and unfiltered by the conversation, so a user asking about brake pads
   * could be shown an unrelated part at a pre-sale price. Suggestions now come
   * from the tool results the model actually consulted, via
   * {@link CatalogToolsService}, or the block reports that there were none.
   */
  buildStructured(
    citedItems: number,
    outcome: 'ok' | 'provider_failed' | 'timed_out',
  ) {
    return {
      grounded: citedItems > 0,
      catalog_items_cited: citedItems,
      // `error` is null on a normal turn; the client renders a retry affordance
      // when it is set rather than treating the fallback prose as real advice.
      error: outcome === 'ok' ? null : outcome,
      disclaimer:
        'AI maslahati. Aniq tashxis uchun mexanikaga murojaat qiling.',
    };
  }

  presentMessage(
    message: { id: string; content: string; createdAt: Date },
    structured: object,
  ) {
    return {
      message_id: message.id,
      role: 'assistant',
      content: message.content,
      structured,
      created_at: message.createdAt.toISOString(),
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private async assertSession(userId: string, sessionId: string) {
    const session = await this.prisma.aiSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.userId !== userId) {
      throw new NotFoundException('Session not found');
    }
    return session;
  }

  private async loadOwnedVehicle(
    userId: string,
    vehicleId: string,
  ): Promise<Vehicle> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle || vehicle.userId !== userId || vehicle.deletedAt) {
      throw new NotFoundException('Vehicle not found');
    }
    return vehicle;
  }

  private async vehicleContext(
    vehicle: Vehicle | null,
  ): Promise<VehicleContext | null> {
    if (!vehicle) return null;
    const [make, model, engine] = await Promise.all([
      this.prisma.vehicleMake.findUnique({ where: { id: vehicle.makeId } }),
      this.prisma.vehicleModelRef.findUnique({
        where: { id: vehicle.modelId },
      }),
      vehicle.engineId
        ? this.prisma.vehicleEngine.findUnique({
            where: { id: vehicle.engineId },
          })
        : Promise.resolve(null),
    ]);
    return {
      vehicle_id: vehicle.id,
      make: make?.name ?? '',
      model: model?.name ?? '',
      year: vehicle.year,
      engine: engine?.name ?? null,
    };
  }
}
