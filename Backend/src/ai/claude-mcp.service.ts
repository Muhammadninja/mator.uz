// src/ai/claude-mcp.service.ts
//
// Thin Claude client used as the AI FALLBACK in the hybrid part-text parser.
// It is only invoked when the rule-based parser is not confident (see
// PartParserService). It returns the raw, validated metadata shape; the
// orchestrator runs the shared sanitizer afterwards.
import Anthropic from '@anthropic-ai/sdk';

import type { ParsedPartMetadata } from './part-parser.types';
import { ruleBasedParse } from './rule-based-parser';
import { sanitizeMetadata } from './part-sanitizer';

export type { ParsedPartMetadata } from './part-parser.types';

const SYSTEM_PROMPT = `Ты — AI-модератор маркетплейса автозапчастей MATOR.uz (Узбекистан).
Тебя вызывают как ПОДСТРАХОВКУ, когда быстрый rule-based парсер не уверен в результате.
Поэтому будь максимально аккуратным: извлекай только то, что реально есть в тексте.

Получи текст от продавца и верни СТРОГО валидный JSON с полями:
- title: ЗАГОЛОВОК ПРОДАВЦА, скопированный ДОСЛОВНО, слово в слово.
  Если текст состоит из абзацев (разделённых пустой строкой) — title это ПЕРВЫЙ абзац целиком.
  Иначе title это ПЕРВАЯ строка текста целиком.
  Ты ЭКСТРАКТОР, а не редактор: НЕ переписывай, НЕ сокращай, НЕ «улучшай», НЕ исправляй
  опечатки и НЕ удаляй из title марку/модель/номер/цену/состояние. Можно только убрать
  лишние пробелы по краям. Заголовок продавца — источник истины.
- description: ТОЛЬКО дополнительная информация (состояние, сторона, количество и т.п.).
  Примеры: "Оригинал", "Новый", "Б/у", "Комплект 4 штуки", "Правая сторона", "С датчиком ABS".
  Если такой информации нет — null. НЕ дублируй сюда название детали.
- brand: ТОЛЬКО марка автомобиля (Chevrolet, Daewoo, Hyundai, Kia, Toyota, Ravon, BYD, Chery, Geely, BMW, Mercedes-Benz и т.д.) или null. НЕ путай марку с моделью.
- models: массив ТОЛЬКО моделей автомобилей (Cobalt, Gentra, Lacetti, Spark и т.д.). Пустой массив [], если моделей нет. НЕ путай модель с названием детали.
- gm_number: ТОЛЬКО OEM/GM номер детали (строка из 5–11 цифр) или null.
- price: ТОЛЬКО числовое значение цены без валюты или null.

ПОРЯДОК ПРИОРИТЕТА (строго соблюдай):
1) ИСКЛЮЧЕНИЕ (высший приоритет) — структурированное объявление из 4 строк:
     Строка 1: заголовок
     Строка 2: описание
     Строка 3: GM-номер (РОВНО 11 цифр)
     Строка 4: цена
   Если 3-я строка — это валидный GM-номер из РОВНО 11 цифр, а 4-я строка — валидная цена,
   то бери gm_number и price НАПРЯМУЮ из строк 3 и 4 и НЕ ищи их в заголовке/описании.
   Марку и модель при этом всё равно определяй из заголовка и/или описания.
2) Иначе извлекай поля из ЗАГОЛОВКА (строка 1).
3) Если какого-то поля всё ещё нет или оно сомнительно — дополни его из ОПИСАНИЯ.
   Значения из ЗАГОЛОВКА всегда в приоритете; описание лишь ДОПОЛНЯЕТ отсутствующее.

ВАЖНО — ДВА ИСТОЧНИКА ДАННЫХ (заголовок И описание):
Заголовок и описание — РАВНОПРАВНЫЕ источники марки, модели, GM-номера и цены
(кроме случая, когда сработало ИСКЛЮЧЕНИЕ выше и GM/цена уже взяты из строк 3 и 4).

Обязательные правила:
1. title = ДОСЛОВНЫЙ заголовок продавца (первый абзац / первая строка). Марку, модель,
   номер, цену и состояние из title НЕ удаляй — их достаточно ИЗВЛЕЧЬ в отдельные поля.
2. brand, models, gm_number, price ИЗВЛЕКАЙ из ЗАГОЛОВКА, а недостающее — из ОПИСАНИЯ,
   не меняя сам title. description оставляй как дополнительный текст продавца.
3. Если деталь подходит для нескольких моделей — верни все в массиве models.
4. Нормализуй регистр ТОЛЬКО в полях brand/models: "cobalt" → "Cobalt", "kia rio" → brand: "Kia", models: ["Rio"]. Title при этом не трогай.
5. Если модели нет — models: []. Если марки нет — brand: null. Если описания нет — description: null.
6. НЕ придумывай отсутствующие данные.
7. Исправляй очевидные опечатки ТОЛЬКО в brand/models (gentra → Gentra, kobal → Cobalt). В title опечатки НЕ трогай.
8. gm_number — это GM/OEM номер детали (последовательность из 8–11 цифр, канонично 11).
   Игнорируй телефоны (обычно 9+ цифр с "+"), годы, пробег, количество, размеры, артикулы
   и прочие числа, которые НЕ являются явным GM-номером или ценой.
9. price — число без валюты. Валюта может быть указана словами: sum, som, сум, сом, so'm,
   сўм, сoʻм, soʻm, UZS. "130.000" → 130000, "1.250.000" → 1250000, "130.00" → 130.
10. Игнорируй телефонные номера, эмодзи и лишний текст ПРИ ИЗВЛЕЧЕНИИ полей (но не переписывай из-за них title).
11. Если сообщение — мусор или товар невозможно определить — верни все поля null/[].
12. Возвращай ТОЛЬКО валидный JSON без Markdown и пояснений.

Примеры (title всегда дословно равен первой строке/абзацу входа):

Вход: "Фильтр масла Cobalt Gentra оригинал 96535062 25000 сум"
Выход: {"title":"Фильтр масла Cobalt Gentra оригинал 96535062 25000 сум","description":"Оригинал","brand":"Chevrolet","models":["Cobalt","Gentra"],"gm_number":"96535062","price":25000}

Вход: "Магнитола для Nexia 3\n\nПроизводство Корея, новая"
Выход: {"title":"Магнитола для Nexia 3","description":"Производство Корея, новая","brand":"Chevrolet","models":["Nexia 3"],"gm_number":null,"price":null}

Вход: "Фара передняя\n\nChevrolet Cobalt оригинал 96549774112 350.000 so'm"
Выход: {"title":"Фара передняя","description":"оригинал","brand":"Chevrolet","models":["Cobalt"],"gm_number":"96549774112","price":350000}

Вход (ИСКЛЮЧЕНИЕ — 4 строки заголовок/описание/GM(11)/цена, GM и цена берутся из строк 3 и 4):
"Фара передняя Cobalt\nОригинал, Корея\n96549774112\n350000 сум"
Выход: {"title":"Фара передняя Cobalt","description":"Оригинал, Корея","brand":"Chevrolet","models":["Cobalt"],"gm_number":"96549774112","price":350000}

Вход: "Тормозной диск Chevrolet Nexia 3, новый, 97168181, 100000 uzs"
Выход: {"title":"Тормозной диск Chevrolet Nexia 3, новый, 97168181, 100000 uzs","description":"Новый","brand":"Chevrolet","models":["Nexia 3"],"gm_number":"97168181","price":100000}

Вход: "генератор 150000"
Выход: {"title":"генератор 150000","description":null,"brand":null,"models":[],"gm_number":null,"price":150000}

Вход: "HShshdh (HShha)"
Выход: {"title":null,"description":null,"brand":null,"models":[],"gm_number":null,"price":null}`;

// Validate the raw JSON returned by Claude against the expected shape.
// Throws if a field has a type that can't be coerced safely.
export function validateMetadataShape(raw: unknown): ParsedPartMetadata {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('ClaudeMcpService: response is not a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const isStringOrNull = (v: unknown) => v === null || typeof v === 'string';

  if (!isStringOrNull(obj.title)) {
    throw new Error('ClaudeMcpService: "title" must be a string or null');
  }
  if (!isStringOrNull(obj.description)) {
    throw new Error('ClaudeMcpService: "description" must be a string or null');
  }
  if (!isStringOrNull(obj.brand)) {
    throw new Error('ClaudeMcpService: "brand" must be a string or null');
  }
  if (!Array.isArray(obj.models)) {
    throw new Error('ClaudeMcpService: "models" must be an array');
  }
  if (!isStringOrNull(obj.gm_number)) {
    throw new Error('ClaudeMcpService: "gm_number" must be a string or null');
  }
  if (obj.price !== null && typeof obj.price !== 'number') {
    throw new Error('ClaudeMcpService: "price" must be a number or null');
  }

  return {
    title: obj.title as string | null,
    description: (obj.description ?? null) as string | null,
    brand: obj.brand as string | null,
    models: (obj.models as unknown[]).map(String),
    gm_number: obj.gm_number as string | null,
    price: obj.price as number | null,
  };
}

// Offline mock used when AI is disabled (AI_MOCK=true) or no API key is set —
// reuses the rule-based parser + sanitizer so behavior stays deterministic.
function mockParse(rawText: string): ParsedPartMetadata {
  const { confidence: _confidence, ...metadata } = ruleBasedParse(rawText);
  return sanitizeMetadata(metadata);
}

export class ClaudeMcpService {
  private readonly client: Anthropic | null;
  private readonly useMock: boolean;
  private static readonly MODEL = 'claude-sonnet-4-6';

  constructor() {
    this.useMock = process.env.AI_MOCK === 'true';
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!this.useMock && !apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  /** True when this service can actually reach Claude (vs. mock/no-key). */
  get isLive(): boolean {
    return !this.useMock && this.client !== null;
  }

  /**
   * Parse seller text with Claude and return the RAW validated metadata shape.
   * Sanitization is the caller's responsibility (PartParserService).
   * Falls back to the offline rule-based parser when AI is unavailable.
   */
  async parsePartText(rawText: string): Promise<ParsedPartMetadata> {
    if (!this.isLive || !this.client) {
      console.warn('[ClaudeMcpService] AI unavailable — using offline rule-based parser');
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
      const raw = JSON.parse(clean) as unknown;
      return validateMetadataShape(raw);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`ClaudeMcpService: failed to parse part text — ${msg}`);
    }
  }
}
