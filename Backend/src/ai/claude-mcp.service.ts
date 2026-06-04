// src/ai/claude-mcp.service.ts
import Anthropic from '@anthropic-ai/sdk';

export interface ParsedPartMetadata {
  title: string | null;
  brand: string | null;
  models: string[];
  gm_number: string | null;
  price: number | null;
}

const SYSTEM_PROMPT = `Ты — AI-модератор маркетплейса автозапчастей MATOR.uz (Узбекистан).
Получи текст от продавца и извлеки данные в формате JSON.

Поля:
- title: ТОЛЬКО название самой детали на русском. ЗАПРЕЩЕНО включать марку или модель авто.
- brand: марка автомобиля (Chevrolet, Daewoo, Hyundai, Kia, Toyota, Ravon, BYD, Chery, Geely и т.д.) или null.
- models: массив моделей автомобилей (Cobalt, Gentra, Lacetti, Spark и т.д.). Пустой массив [], если модели не упомянуты.
- gm_number: OEM/GM номер детали (строка из 5–11 цифр) или null.
- price: только числовое значение цены без валюты или null.

Обязательные правила:
1. НИКОГДА не включать марку или модель авто в title.
2. Если деталь подходит для нескольких моделей — вернуть все в массиве models.
3. Нормализовать регистр: "cobalt" → "Cobalt", "kia rio" → brand: "Kia", models: ["Rio"].
4. Если модель не указана — models: [].
5. Если марка не указана — brand: null.
6. Не придумывать отсутствующие данные.
7. Исправлять очевидные опечатки (gentra → Gentra, kobal → Cobalt).
8. Игнорировать телефонные номера, эмодзи и лишний текст.
9. Если сообщение — мусор или товар невозможно определить — вернуть все поля null/[].
10. Возвращать ТОЛЬКО валидный JSON без Markdown и пояснений.

Примеры:

Вход: "фильтр масла кобальт gentra lacetti 96535062 25000 сум"
Выход: {"title":"Фильтр масляный","brand":"Chevrolet","models":["Cobalt","Gentra","Lacetti"],"gm_number":"96535062","price":25000}

Вход: "ступица передняя spark matiz"
Выход: {"title":"Ступица передняя","brand":null,"models":["Spark","Matiz"],"gm_number":null,"price":null}

Вход: "Тормозной диск Chevrolet Nexia 3, 97168181, 100000 uzs"
Выход: {"title":"Тормозной диск","brand":"Chevrolet","models":["Nexia 3"],"gm_number":"97168181","price":100000}

Вход: "генератор 150000"
Выход: {"title":"Генератор","brand":null,"models":[],"gm_number":null,"price":150000}

Вход: "привет как дела"
Выход: {"title":null,"brand":null,"models":[],"gm_number":null,"price":null}`;

const CAR_BRANDS: Record<string, string> = {
  chevrolet: 'Chevrolet',
  daewoo: 'Daewoo',
  hyundai: 'Hyundai',
  kia: 'Kia',
  toyota: 'Toyota',
  ravon: 'Ravon',
  byd: 'BYD',
  chery: 'Chery',
  geely: 'Geely',
  haval: 'Haval',
  changan: 'Changan',
  jac: 'JAC',
  omoda: 'Omoda',
  ford: 'Ford',
  mitsubishi: 'Mitsubishi',
  subaru: 'Subaru',
  honda: 'Honda',
  nissan: 'Nissan',
  volkswagen: 'Volkswagen',
  bmw: 'BMW',
  mercedes: 'Mercedes',
  lada: 'Lada',
};

const CAR_MODELS: Record<string, string> = {
  cobalt: 'Cobalt',
  kobal: 'Cobalt',
  gentra: 'Gentra',
  spark: 'Spark',
  'nexia 3': 'Nexia 3',
  nexia: 'Nexia',
  damas: 'Damas',
  labo: 'Labo',
  lacetti: 'Lacetti',
  matiz: 'Matiz',
  captiva: 'Captiva',
  tracker: 'Tracker',
  equinox: 'Equinox',
  malibu: 'Malibu',
  cruze: 'Cruze',
  orlando: 'Orlando',
  rio: 'Rio',
  cerato: 'Cerato',
  sportage: 'Sportage',
  accent: 'Accent',
  elantra: 'Elantra',
  sonata: 'Sonata',
  tucson: 'Tucson',
  creta: 'Creta',
  camry: 'Camry',
  corolla: 'Corolla',
  polo: 'Polo',
  golf: 'Golf',
  passat: 'Passat',
  tiguan: 'Tiguan',
  jetta: 'Jetta',
};

function normalizeMetadata(parsed: ParsedPartMetadata): ParsedPartMetadata {
  return {
    title: parsed.title?.trim() || null,
    brand: parsed.brand?.trim() || null,
    models: Array.isArray(parsed.models)
      ? [...new Set(parsed.models.map((m) => m.trim()).filter(Boolean))]
      : [],
    gm_number: parsed.gm_number?.trim() || null,
    price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : null,
  };
}

function mockParse(rawText: string): ParsedPartMetadata {
  const textWithoutPrice = rawText.replace(/(\d[\d\s]*)\s*(uzs|UZS|сўм|сум)/gi, '');
  const gmMatch = textWithoutPrice.match(/\b\d{5,11}\b/);
  const priceMatch = rawText.match(/(\d+)\s*(uzs|UZS|сўм|сум)/i);

  const lower = rawText.toLowerCase();

  let brand: string | null = null;
  for (const [key, val] of Object.entries(CAR_BRANDS)) {
    if (new RegExp(`\\b${key}\\b`, 'i').test(lower)) {
      brand = val;
      break;
    }
  }

  const models: string[] = [];
  for (const [key, val] of Object.entries(CAR_MODELS)) {
    if (new RegExp(`\\b${key.replace(' ', '\\s+')}\\b`, 'i').test(lower)) {
      models.push(val);
    }
  }

  const titleMatch = rawText.match(/^([^0-9\n,(]+)/);
  const rawTitle = titleMatch ? titleMatch[1].trim() : rawText.slice(0, 60).trim();

  return normalizeMetadata({
    title: rawTitle.length >= 3 ? rawTitle : null,
    brand,
    models,
    gm_number: gmMatch ? gmMatch[0] : null,
    price: priceMatch ? parseInt(priceMatch[1], 10) : null,
  });
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
      const parsed = normalizeMetadata(JSON.parse(clean) as ParsedPartMetadata);

      return parsed;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`ClaudeMcpService: failed to parse part text — ${msg}`);
    }
  }
}
