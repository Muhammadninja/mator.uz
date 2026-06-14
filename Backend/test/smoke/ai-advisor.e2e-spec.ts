import { ClaudeService } from '../../src/ai-advisor/claude.service';
import { AiAdvisorService } from '../../src/ai-advisor/ai-advisor.service';
import { createPrismaMock, fakeConfig, buildVehicle, PrismaMock } from '../utils/harness';

describe('AI Advisor smoke', () => {
  let prisma: PrismaMock;
  beforeEach(() => (prisma = createPrismaMock()));

  describe('ClaudeService (no API key → stub)', () => {
    const claude = new ClaudeService(fakeConfig()); // ANTHROPIC_API_KEY unset

    it('builds a vehicle-grounded Uzbek system prompt', () => {
      const sys = claude.buildSystem({ vehicle_id: 'veh_1', make: 'Chevrolet', model: 'Cobalt', year: 2022, engine: 'B15D2' });
      expect(sys).toContain('Chevrolet Cobalt 2022');
      expect(sys).toContain('B15D2');
    });

    it('fullReply returns the stub when no key is configured', async () => {
      const reply = await claude.fullReply('sys', [{ role: 'user', content: 'Dvigatel shovqin qilyapti' }]);
      expect(reply).toContain('test rejimidagi');
      expect(reply).toContain('Dvigatel');
    });

    it('streamReply yields the stub text', async () => {
      const chunks: string[] = [];
      for await (const c of claude.streamReply('sys', [{ role: 'user', content: 'salom' }])) chunks.push(c);
      expect(chunks.join('')).toContain('test rejimidagi');
    });
  });

  describe('AiAdvisorService', () => {
    it('createSession resolves and returns the vehicle context', async () => {
      const svc = new AiAdvisorService(prisma);
      prisma.vehicle.findUnique.mockResolvedValue(buildVehicle({ id: 'veh_1', userId: 'usr_1', deletedAt: null }));
      prisma.vehicleMake.findUnique.mockResolvedValue({ name: 'Chevrolet' });
      prisma.vehicleModelRef.findUnique.mockResolvedValue({ name: 'Cobalt' });
      prisma.vehicleEngine.findUnique.mockResolvedValue({ name: 'B15D2' });
      prisma.aiSession.create.mockResolvedValue({ id: 'ai_1', createdAt: new Date('2026-06-14T00:00:00Z') });

      const res = await svc.createSession('usr_1', { vehicle_id: 'veh_1' } as any);
      expect(res.session_id).toBe('ai_1');
      expect(res.vehicle_context).toEqual({ vehicle_id: 'veh_1', make: 'Chevrolet', model: 'Cobalt', year: 2022, engine: 'B15D2' });
    });

    it('buildStructured grounds suggestions in the catalog with a disclaimer', async () => {
      const svc = new AiAdvisorService(prisma);
      prisma.catalogPart.findMany.mockResolvedValue([{ id: 'part_belt', title: 'Timing belt', priceUzs: 185000 }]);
      prisma.providerServiceOffering.findMany.mockResolvedValue([{ id: 'svc_oil', name: 'Oil change', priceUzs: 120000 }]);

      const res: any = await svc.buildStructured(buildVehicle({ trimId: 'trim_lt' }));
      expect(res.suggested_parts).toEqual([{ part_id: 'part_belt', title: 'Timing belt', price_uzs: 185000 }]);
      expect(res.suggested_services[0].service_id).toBe('svc_oil');
      expect(res.confidence).toBe(0.78);
      expect(res.disclaimer).toMatch(/mexanika/);
    });
  });
});
