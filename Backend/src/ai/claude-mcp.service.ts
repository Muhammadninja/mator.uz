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
- title: ТОЛЬКО название самой детали на русском. Краткое имя детали и больше ничего.
  Примеры корректного title: "Фильтр масляный", "Генератор", "Передняя ступица", "Тормозной диск".
  ЗАПРЕЩЕНО включать в title: состояние, марку авто, модель авто, OEM/GM номер, цену.
- description: ТОЛЬКО дополнительная информация (состояние, сторона, количество и т.п.).
  Примеры: "Оригинал", "Новый", "Б/у", "Комплект 4 штуки", "Правая сторона", "С датчиком ABS".
  Если такой информации нет — null. НЕ дублируй сюда название детали.
- brand: ТОЛЬКО марка автомобиля (Chevrolet, Daewoo, Hyundai, Kia, Toyota, Ravon, BYD, Chery, Geely, BMW, Mercedes-Benz и т.д.) или null. НЕ путай марку с моделью.
- models: массив ТОЛЬКО моделей автомобилей (Cobalt, Gentra, Lacetti, Spark и т.д.). Пустой массив [], если моделей нет. НЕ путай модель с названием детали.
- gm_number: ТОЛЬКО OEM/GM номер детали (строка из 5–11 цифр) или null.
- price: ТОЛЬКО числовое значение цены без валюты или null.

Обязательные правила:
1. НИКОГДА не смешивай поля: title отдельно, description отдельно, brand отдельно, models отдельно.
2. Состояние и любую характеристику товара выноси в description, а не в title.
3. Если деталь подходит для нескольких моделей — верни все в массиве models.
4. Нормализуй регистр: "cobalt" → "Cobalt", "kia rio" → brand: "Kia", models: ["Rio"].
5. Если модели нет — models: []. Если марки нет — brand: null. Если описания нет — description: null.
6. НЕ придумывай отсутствующие данные.
7. Исправляй очевидные опечатки (gentra → Gentra, kobal → Cobalt).
8. Игнорируй телефонные номера, эмодзи и лишний текст.
9. Если сообщение — мусор или товар невозможно определить — верни все поля null/[].
10. Возвращай ТОЛЬКО валидный JSON без Markdown и пояснений.

Примеры:

Вход: "Фильтр масла Cobalt Gentra оригинал 96535062 25000 сум"
Выход: {"title":"Фильтр масляный","description":"Оригинал","brand":"Chevrolet","models":["Cobalt","Gentra"],"gm_number":"96535062","price":25000}

Вход: "ступица передняя spark matiz правая сторона"
Выход: {"title":"Ступица передняя","description":"Правая сторона","brand":null,"models":["Spark","Matiz"],"gm_number":null,"price":null}

Вход: "Тормозной диск Chevrolet Nexia 3, новый, 97168181, 100000 uzs"
Выход: {"title":"Тормозной диск","description":"Новый","brand":"Chevrolet","models":["Nexia 3"],"gm_number":"97168181","price":100000}

Вход: "генератор 150000"
Выход: {"title":"Генератор","description":null,"brand":null,"models":[],"gm_number":null,"price":150000}

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
