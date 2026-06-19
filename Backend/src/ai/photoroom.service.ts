import axios from 'axios';
import FormData from 'form-data';

const PHOTOROOM_ENDPOINT = 'https://image-api.photoroom.com/v2/edit';

export class PhotoroomService {
  private readonly apiKey: string;

  constructor() {
    const key = process.env.PHOTOROOM_API_KEY;
    if (!key) throw new Error('PHOTOROOM_API_KEY is not set');
    this.apiKey = key;
  }

  // Собираем форму запроса. Поток form-data одноразовый, поэтому строим
  // её заново на каждую попытку.
  private buildForm(imageBuffer: Buffer): FormData {
    const form = new FormData();

    // Исходное изображение
    form.append('imageFile', imageBuffer, {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    });

    // Удаление фона
    form.append('removeBackground', 'true');

    // ── Фон ──────────────────────────────────────────────────────────────────
    form.append(
      'background.prompt',
      'Create a clean premium studio product background. Background: light gray gradient, minimalist, modern ecommerce style, soft ambient lighting, subtle realistic floor shadow, centered object, no decorations, no additional objects, no text, no reflections, professional catalog photography',
    );

    // ── ИИ-тени ───────────────────────────────────────────────────────────────
    // ai.auto-with-overrides требует модель 2026-04-15 — указываем через заголовок
    form.append('shadow.mode', 'ai.auto-with-overrides');
    form.append('shadow.intensityOverride', '0.4');  // число, не строка — API ожидает number
    form.append('shadow.softnessOverride', '0.6');   // число, не строка

    // ── AI-бьютификация для авто ──────────────────────────────────────────────
    // Допустимые значения: ai.auto | ai.food | ai.car
    form.append('beautify.mode', 'ai.car');

    // ── Композиция ────────────────────────────────────────────────────────────
    // outputSize: паттерн ^(auto|\d+x\d+|originalImage|croppedSubject)$
    form.append('outputSize', '1000x1000');
    // padding: число 0–0.49 (не строка)
    form.append('padding', '0.1');
    // scaling: 'fit' | 'fill' — по умолчанию уже 'fit', но пишем явно
    form.append('scaling', 'fit');

    return form;
  }

  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    // Пайплайн (удаление фона + ИИ-тени + бьютификация + композиция 1000x1000)
    // тяжёлый, поэтому держим запас по времени и одну повторную попытку
    // на случай таймаута или временной ошибки сервера (5xx).
    const MAX_ATTEMPTS = 2;
    const TIMEOUT_MS = 60_000;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const form = this.buildForm(imageBuffer);
      try {
        const response = await axios.post(PHOTOROOM_ENDPOINT, form, {
          headers: {
            ...form.getHeaders(),
            'x-api-key': this.apiKey,
            'Accept': 'image/png, application/json',
            // Активируем модель теней 2026-04-15, которая поддерживает
            // ai.auto-with-overrides + intensityOverride + softnessOverride
            'pr-ai-shadows-model-version': '2026-04-15',
          },
          responseType: 'arraybuffer',
          timeout: TIMEOUT_MS,
        });

        return Buffer.from(response.data);
      } catch (error) {
        lastError = error;

        // 4xx — это ошибка запроса, повтор не поможет: выходим сразу с телом ответа.
        if (axios.isAxiosError(error) && error.response) {
          const status = error.response.status;
          const isServerError = status >= 500;
          if (!isServerError) {
            const body = Buffer.from(error.response.data).toString('utf8');
            throw new Error(
              `PhotoroomService: background removal failed — HTTP ${status}: ${body}`,
            );
          }
        }

        // Таймаут или 5xx — повторяем, если попытки остались.
        if (attempt < MAX_ATTEMPTS) continue;
      }
    }

    // Все попытки исчерпаны.
    if (axios.isAxiosError(lastError) && lastError.response) {
      const body = Buffer.from(lastError.response.data).toString('utf8');
      throw new Error(
        `PhotoroomService: background removal failed — HTTP ${lastError.response.status}: ${body}`,
      );
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`PhotoroomService: background removal failed — ${msg}`);
  }
}