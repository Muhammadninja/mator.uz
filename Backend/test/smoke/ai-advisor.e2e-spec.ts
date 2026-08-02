import { ClaudeService } from '../../src/ai-advisor/claude.service';
import { AiAdvisorService } from '../../src/ai-advisor/ai-advisor.service';
import { CatalogToolsService } from '../../src/ai-advisor/catalog-tools.service';
import {
  createPrismaMock,
  fakeConfig,
  buildVehicle,
  PrismaMock,
} from '../utils/harness';

/**
 * End-to-end-ish smoke: the AI advisor pieces wired together, with the PROVIDER
 * MOCKED throughout. No test here may reach a live AI API.
 */

const allowingLimiter = () => ({
  consume: jest.fn().mockResolvedValue({
    allowed: true,
    limit: 20,
    current: 1,
    remaining: 19,
    retryAfter: 0,
  }),
  check: jest.fn(),
  remaining: jest.fn(),
  retryAfter: jest.fn(),
});

describe('AI Advisor smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  describe('ClaudeService (no API key → stub)', () => {
    const claude = () =>
      new ClaudeService(fakeConfig(), { run: jest.fn() } as never); // ANTHROPIC_API_KEY unset

    it('builds a vehicle-grounded Uzbek system prompt', () => {
      const sys = claude().buildSystem({
        vehicle_id: 'veh_1',
        make: 'Chevrolet',
        model: 'Cobalt',
        year: 2022,
        engine: 'B15D2',
      });
      expect(sys).toContain('Chevrolet Cobalt 2022');
      expect(sys).toContain('B15D2');
    });

    it('reply returns the stub when no key is configured', async () => {
      const res = await claude().reply('sys', [
        { role: 'user', content: 'Dvigatel shovqin qilyapti' },
      ]);
      expect(res.text).toContain('test rejimidagi');
      expect(res.text).toContain('Dvigatel');
      expect(res.outcome).toBe('ok');
    });
  });

  describe('AiAdvisorService', () => {
    const svc = () => new AiAdvisorService(prisma, allowingLimiter() as never);

    it('createSession resolves and returns the vehicle context', async () => {
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

      const res = await svc().createSession('usr_1', {
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

    it('structured block reports catalogue grounding rather than invented suggestions', async () => {
      const res = svc().buildStructured(2, 'ok');
      expect(res.grounded).toBe(true);
      expect(res.catalog_items_cited).toBe(2);
      expect(res.disclaimer).toMatch(/mexanika/);
      // The catalogue is never queried directly for suggestions any more.
      expect(prisma.catalogPart.findMany).not.toHaveBeenCalled();
    });
  });

  describe('catalogue grounding, end to end', () => {
    it('a price in the reply comes from the catalogue service, not the model', async () => {
      const parts = {
        list: jest.fn().mockResolvedValue({
          items: [
            {
              id: 'part_pads',
              title: 'Brake pads',
              kind: 'SPARE_PART',
              brand: { name: 'Bosch' },
              price_uzs: 185000,
              price_label: 'UZS 185 000',
              in_stock: true,
              rating_avg: 4.5,
              compatibility: { status: 'fits' },
              seller: { name: 'AutoPro', certified: true },
            },
          ],
          total: 1,
        }),
        detail: jest.fn(),
      };
      const tools = new CatalogToolsService(
        parts as never,
        { list: jest.fn() } as never,
      );

      // The model asks for a search, then answers using the tool result.
      const create = jest
        .fn()
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'search_catalog',
              input: { q: 'brake pads' },
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'Tormoz kolodkalari — UZS 185 000.' },
          ],
        });

      const claude = new ClaudeService(fakeConfig(), tools);
      (claude as unknown as { client: unknown }).client = {
        messages: { create },
      };

      const res = await claude.reply('sys', [
        { role: 'user', content: 'tormoz kolodka narxi?' },
      ]);

      expect(parts.list).toHaveBeenCalled();
      expect(res.citedItems).toBe(1);
      expect(res.text).toContain('185 000');

      // The tool result handed to the model carried the authoritative price.
      const toolResultTurn = create.mock.calls[1][0].messages.at(-1);
      expect(toolResultTurn.content[0].content).toContain('185000');
    });
  });
});
