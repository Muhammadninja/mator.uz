import {
  NotFoundException,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { AiMessageRole } from '@prisma/client';
import { AiAdvisorService } from './ai-advisor.service';
import {
  createPrismaMock,
  buildVehicle,
  PrismaMock,
} from '../../test/utils/harness';

/** A rate limiter double that allows by default; flip `allowed` to throttle. */
function fakeLimiter(allowed = true, retryAfter = 42) {
  return {
    consume: jest.fn().mockResolvedValue({
      allowed,
      limit: 20,
      current: allowed ? 1 : 21,
      remaining: allowed ? 19 : 0,
      retryAfter: allowed ? 0 : retryAfter,
    }),
    check: jest.fn(),
    remaining: jest.fn(),
    retryAfter: jest.fn(),
  };
}

describe('AiAdvisorService', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  const build = (limiter = fakeLimiter()) =>
    new AiAdvisorService(prisma, limiter as never);

  describe('session ownership', () => {
    it('creates a session with the resolved vehicle context', async () => {
      prisma.vehicle.findUnique.mockResolvedValue(
        buildVehicle({ id: 'veh_1', userId: 'usr_1', deletedAt: null }),
      );
      prisma.vehicleMake.findUnique.mockResolvedValue({ name: 'Chevrolet' });
      prisma.vehicleModelRef.findUnique.mockResolvedValue({ name: 'Cobalt' });
      prisma.vehicleEngine.findUnique.mockResolvedValue({ name: 'B15D2' });
      prisma.aiSession.create.mockResolvedValue({
        id: 'ai_1',
        createdAt: new Date('2026-06-14T00:00:00Z'),
      });

      const res = await build().createSession('usr_1', {
        vehicle_id: 'veh_1',
      } as never);
      expect(res.session_id).toBe('ai_1');
      expect(res.vehicle_context).toEqual({
        vehicle_id: 'veh_1',
        make: 'Chevrolet',
        model: 'Cobalt',
        year: 2022,
        engine: 'B15D2',
      });
    });

    it("refuses to open a session on another user's vehicle", async () => {
      prisma.vehicle.findUnique.mockResolvedValue(
        buildVehicle({ id: 'veh_1', userId: 'usr_OTHER', deletedAt: null }),
      );
      await expect(
        build().createSession('usr_1', { vehicle_id: 'veh_1' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.aiSession.create).not.toHaveBeenCalled();
    });

    it("refuses to restore another user's conversation", async () => {
      prisma.aiSession.findUnique.mockResolvedValue({
        id: 'ai_1',
        userId: 'usr_OTHER',
      });
      await expect(build().restore('usr_1', 'ai_1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.aiMessage.findMany).not.toHaveBeenCalled();
    });

    it("refuses to post into another user's conversation", async () => {
      prisma.aiSession.findUnique.mockResolvedValue({
        id: 'ai_1',
        userId: 'usr_OTHER',
      });
      await expect(
        build().assertSessionWithVehicle('usr_1', 'ai_1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('restores messages in stored order', async () => {
      prisma.aiSession.findUnique.mockResolvedValue({
        id: 'ai_1',
        userId: 'usr_1',
      });
      prisma.aiMessage.findMany.mockResolvedValue([
        {
          id: 'm1',
          role: AiMessageRole.USER,
          content: 'salom',
          createdAt: new Date('2026-06-14T00:00:00Z'),
        },
        {
          id: 'm2',
          role: AiMessageRole.ASSISTANT,
          content: 'javob',
          createdAt: new Date('2026-06-14T00:00:01Z'),
        },
      ]);

      const res = await build().restore('usr_1', 'ai_1');
      expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(prisma.aiMessage.findMany.mock.calls[0][0].orderBy).toEqual({
        createdAt: 'asc',
      });
    });
  });

  describe('rate limiting', () => {
    it('charges the budget against the USER, not the session', async () => {
      const limiter = fakeLimiter(true);
      await build(limiter).assertWithinRateLimit('usr_1', 20, 300);

      expect(limiter.consume).toHaveBeenCalledWith(
        'rate:ai:message:usr_1',
        20,
        300,
      );
    });

    it('throws 429 with a retry hint once the budget is spent', async () => {
      const limiter = fakeLimiter(false, 42);
      try {
        await build(limiter).assertWithinRateLimit('usr_1', 20, 300);
        throw new Error('expected a 429');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const e = err as HttpException;
        expect(e.getStatus()).toBe(429);
        expect((e.getResponse() as { retry_after: number }).retry_after).toBe(
          42,
        );
      }
    });
  });

  describe('history', () => {
    it('replays the MOST RECENT turns, oldest first', async () => {
      // Stored newest-first (as the descending query returns them).
      prisma.aiMessage.findMany.mockResolvedValue([
        {
          id: 'm3',
          role: AiMessageRole.USER,
          content: 'newest',
          attachments: null,
        },
        {
          id: 'm2',
          role: AiMessageRole.ASSISTANT,
          content: 'middle',
          attachments: null,
        },
        {
          id: 'm1',
          role: AiMessageRole.USER,
          content: 'oldest',
          attachments: null,
        },
      ]);

      const msgs = await build().toClaudeMessages('ai_1', 20);

      expect(prisma.aiMessage.findMany.mock.calls[0][0].orderBy).toEqual({
        createdAt: 'desc',
      });
      expect(prisma.aiMessage.findMany.mock.calls[0][0].take).toBe(20);
      // Reversed for the model: the newest turn must be LAST, or the model never
      // sees the message the user just sent.
      expect(msgs.map((m) => m.content)).toEqual([
        'oldest',
        'middle',
        'newest',
      ]);
    });

    it('honours the configured history limit', async () => {
      prisma.aiMessage.findMany.mockResolvedValue([]);
      await build().toClaudeMessages('ai_1', 5);
      expect(prisma.aiMessage.findMany.mock.calls[0][0].take).toBe(5);
    });

    it('drops a stored attachment whose host is not allowlisted', async () => {
      prisma.aiMessage.findMany.mockResolvedValue([
        {
          id: 'm1',
          role: AiMessageRole.USER,
          content: 'look',
          attachments: [{ type: 'image', url: 'http://evil.test/x.png' }],
        },
      ]);

      const msgs = await build().toClaudeMessages('ai_1', 20);
      // Falls back to plain text — the untrusted URL is never forwarded.
      expect(msgs[0].content).toBe('look');
    });
  });

  describe('message ingestion', () => {
    it('rejects an image attachment on an untrusted host', () => {
      expect(() =>
        build().persistUserMessage('ai_1', {
          content: 'hi',
          attachments: [{ type: 'image', url: 'http://evil.test/x.png' }],
        } as never),
      ).toThrow(BadRequestException);
      expect(prisma.aiMessage.create).not.toHaveBeenCalled();
    });

    it('persists the assistant reply with its structured block', async () => {
      prisma.aiMessage.create.mockResolvedValue({
        id: 'm2',
        content: 'javob',
        createdAt: new Date(),
      });
      await build().persistAssistantMessage('ai_1', 'javob', {
        grounded: true,
      });

      const data = prisma.aiMessage.create.mock.calls[0][0].data;
      expect(data.role).toBe(AiMessageRole.ASSISTANT);
      expect(data.sessionId).toBe('ai_1');
    });
  });

  describe('structured block', () => {
    it('reports grounding when the tools returned catalogue rows', () => {
      const s = build().buildStructured(3, 'ok');
      expect(s.grounded).toBe(true);
      expect(s.catalog_items_cited).toBe(3);
      expect(s.error).toBeNull();
    });

    it('reports ungrounded when no catalogue row backed the reply', () => {
      const s = build().buildStructured(0, 'ok');
      expect(s.grounded).toBe(false);
      expect(s.catalog_items_cited).toBe(0);
    });

    it('surfaces a provider failure to the client', () => {
      expect(build().buildStructured(0, 'provider_failed').error).toBe(
        'provider_failed',
      );
      expect(build().buildStructured(0, 'timed_out').error).toBe('timed_out');
    });

    it('never invents suggested parts or a fabricated confidence score', () => {
      const s = build().buildStructured(0, 'ok') as Record<string, unknown>;
      // The old implementation shipped unrelated parts and a hardcoded 0.78.
      expect(s.suggested_parts).toBeUndefined();
      expect(s.confidence).toBeUndefined();
      expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
    });

    it('always carries the advisory disclaimer', () => {
      expect(build().buildStructured(2, 'ok').disclaimer).toMatch(/mexanika/);
    });
  });
});
