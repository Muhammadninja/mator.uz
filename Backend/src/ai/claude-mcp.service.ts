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
- gm_number: OEM / GM-номер детали (строка цифр, 5–11 символов) или null
- title: ТОЛЬКО название самой детали на русском. ЗАПРЕЩЕНО включать марку/модель авто
- car_model: марка и/или модель автомобиля или null

Правила:
- Скобки в тексте — внутри всегда марка/модель. Перенеси ВСЁ содержимое скобок в car_model, скобки из title убери
- Если марка/модель упомянута без скобок — тоже выноси в car_model, из title убирай
- Если в тексте несколько моделей (например Chevrolet и Nexia) — объединяй: "Chevrolet Nexia 3"
- Если марка/модель не упомянута — car_model: null, не выдумывай
- Цены (число + uzs/сум/сўм) и OEM-номера в car_model не включать
- title нормализуй на русском языке

Популярные марки/модели в Узбекистане:
Chevrolet/UzAuto: Cobalt, Gentra, Spark, Nexia 3, Damas, Labo, Lacetti, Matiz, Captiva, Tracker, Equinox, Malibu, Cruze, Orlando
Китайские: BYD, Chery, Geely, Haval, Changan, JAC, Omoda
Другие: Hyundai, Kia, Toyota, Honda, Nissan, Mercedes, BMW, Audi, Volkswagen, Lada, Daewoo, Ravon

Отвечай ТОЛЬКО валидным JSON без Markdown и пояснений.

Примеры:
Вход: "фильтр масла кобальт 96535062 15000 сум"
Выход: {"gm_number":"96535062","title":"Фильтр масляный","car_model":"Cobalt"}

Вход: "Тормозной диск (Chevrolet nexia 3), 97168181, 100000000 uzs"
Выход: {"gm_number":"97168181","title":"Тормозной диск","car_model":"Chevrolet Nexia 3"}

Вход: "Выхлопная труба (Volkswagen boro) 987654321 30000 сум"
Выход: {"gm_number":"987654321","title":"Выхлопная труба","car_model":"Volkswagen Boro"}

Вход: "Труба Ravon R4 Spark 98718393 10000000"
Выход: {"gm_number":"98718393","title":"Труба","car_model":"Ravon R4 Spark"}

Вход: "тормозной диск nexia3 96281323"
Выход: {"gm_number":"96281323","title":"Тормозной диск","car_model":"Nexia 3"}

Вход: "генератор 50000"
Выход: {"gm_number":null,"title":"Генератор","car_model":null}`;

const CAR_KEYWORDS = [
  'chevrolet', 'cobalt', 'gentra', 'spark', 'nexia', 'damas', 'labo',
  'lacetti', 'matiz', 'captiva', 'tracker', 'equinox', 'malibu', 'cruze',
  'orlando', 'tahoe', 'traverse', 'daewoo', 'ravon', 'byd', 'chery',
  'geely', 'haval', 'changan', 'jac', 'omoda', 'hyundai', 'kia', 'toyota',
  'honda', 'nissan', 'mercedes', 'bmw', 'audi', 'volkswagen', 'vw', 'lada',
  'ford', 'mitsubishi', 'subaru',
];

function capitalizeWords(str: string): string {
  return str
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function sanitizeMetadata(parsed: ParsedPartMetadata): ParsedPartMetadata {
  if (!parsed.car_model) {
    // Шаг 1: закрытые скобки — "Тормозной диск (Chevrolet nexia 3)"
    const closedBracket = parsed.title.match(/^(.*?)\s*\(([^)]+)\)\s*(.*)$/);
    if (closedBracket) {
      const before = closedBracket[1].trim();
      const inside = closedBracket[2].trim();
      const after  = closedBracket[3].trim();
      parsed.title = [before, after].filter(Boolean).join(' ').trim();
      parsed.car_model = capitalizeWords(inside);
      return parsed;
    }

    // Шаг 2: незакрытые скобки — "Труба (Ravon R"
    const unclosedBracket = parsed.title.match(/^(.*?)\s*\((.+)$/);
    if (unclosedBracket) {
      parsed.title = unclosedBracket[1].trim();
      parsed.car_model = capitalizeWords(unclosedBracket[2].trim());
      return parsed;
    }

    // Шаг 3: keyword fallback — ищем все известные марки в title и собираем их
    const titleLower = parsed.title.toLowerCase();
    const foundKeywords = CAR_KEYWORDS.filter((m) => {
      // Проверяем точное совпадение слова (word boundary)
      return new RegExp(`\\b${m}\\b`).test(titleLower);
    });

    if (foundKeywords.length > 0) {
      // Собираем все найденные марки в car_model
      parsed.car_model = foundKeywords
        .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
        .join(' ');
      // Убираем их из title
      for (const kw of foundKeywords) {
        parsed.title = parsed.title
          .replace(new RegExp(`\\b${kw}\\b`, 'gi'), '')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }
    }
  }

  return parsed;
}

function mockParse(rawText: string): ParsedPartMetadata {
  const textWithoutPrice = rawText.replace(/(\d+)\s*(uzs|UZS|сўм|сум)/i, '');
  const gmMatch = textWithoutPrice.match(/\b\d{5,11}\b/);
  const carMatch = CAR_KEYWORDS.find((m) => rawText.toLowerCase().includes(m));
  const titleMatch = rawText.match(/^([^0-9\n,(]+)/);
  const raw: ParsedPartMetadata = {
    gm_number: gmMatch ? gmMatch[0] : null,
    title: titleMatch ? titleMatch[1].trim() : rawText.slice(0, 60).trim(),
    car_model: carMatch ? carMatch.charAt(0).toUpperCase() + carMatch.slice(1) : null,
  };
  return sanitizeMetadata(raw);
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

      const clean = content.text.replace(/```json|```/g, '').trim();
      const parsed = sanitizeMetadata(JSON.parse(clean) as ParsedPartMetadata);

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