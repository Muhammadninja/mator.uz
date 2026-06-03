// src/ai/claude-mcp.service.ts
import Anthropic from '@anthropic-ai/sdk';

export interface ParsedPartMetadata {
  gm_number: string | null;
  title: string;
  car_model: string | null;
}

const SYSTEM_PROMPT = `Ты — AI-модератор маркетплейса автозапчастей MATOR.uz (Узбекистан).
Твоя задача: получить текст от продавца и извлечь из него ровно 3 поля в формате JSON.
Поля:
- gm_number: OEM / GM-номер детали (строка, если есть) или null
- title: название детали на русском языке
- car_model: марка/модель автомобиля (например: Cobalt, Gentra, Spark, Nexia, Damas и т.д.) или null

Отвечай ТОЛЬКО валидным JSON-объектом. Никаких пояснений, никакого Markdown.
Пример: {"gm_number":"96535062","title":"Фильтр масляный","car_model":"Cobalt"}`;

const CAR_MODELS = ['cobalt', 'gentra', 'spark', 'nexia', 'damas', 'labo', 'lacetti', 'matiz', 'captiva', 'tracker', 'equinox'];

/** Regex-based fallback used when AI_MOCK=true or no API key is available. */
function mockParse(rawText: string): ParsedPartMetadata {
  const gmMatch = rawText.match(/\b\d{7,11}\b/);
  const carMatch = CAR_MODELS.find((m) => rawText.toLowerCase().includes(m));
  // Everything before the first number/car model keyword is treated as the title
  const titleMatch = rawText.match(/^([^0-9\n,]+)/);
  return {
    gm_number: gmMatch ? gmMatch[0] : null,
    title: titleMatch ? titleMatch[1].trim() : rawText.slice(0, 60).trim(),
    car_model: carMatch ? carMatch.charAt(0).toUpperCase() + carMatch.slice(1) : null,
  };
}

export class ClaudeMcpService {
  private readonly client: Anthropic | null;
  private readonly useMock: boolean;
  private static readonly MODEL = 'claude-sonnet-4-5';

  constructor() {
    this.useMock = process.env.AI_MOCK === 'true';
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!this.useMock && !apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  async parsePartText(rawText: string): Promise<ParsedPartMetadata> {
    if (this.useMock || !this.client) {
      console.warn('[ClaudeMcpService] Running in MOCK mode — using regex parser');
      return mockParse(rawText);
    }

    try {
      const message = await this.client.messages.create({
        model: ClaudeMcpService.MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: rawText }],
      });

      const content = message.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const parsed = JSON.parse(content.text) as ParsedPartMetadata;

      if (typeof parsed.title !== 'string' || parsed.title.trim() === '') {
        throw new Error('Claude returned invalid metadata: missing title');
      }

      return parsed;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`ClaudeMcpService: failed to parse part text — ${msg}`);
    }
  }
}
