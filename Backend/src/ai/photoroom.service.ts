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

  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    const form = new FormData();

    // Исходное изображение
    form.append('imageFile', imageBuffer, {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    });

    // Удаление фона
    form.append('removeBackground', 'true');

    // ── Фон ──────────────────────────────────────────────────────────────────
    form.append('background.color', 'FFFFFF');

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
        timeout: 30_000,
      });

      return Buffer.from(response.data);
    } catch (error) {
      // Достаём тело ответа из arraybuffer для диагностики 4xx
      if (axios.isAxiosError(error) && error.response) {
        const body = Buffer.from(error.response.data).toString('utf8');
        throw new Error(
          `PhotoroomService: background removal failed — HTTP ${error.response.status}: ${body}`,
        );
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`PhotoroomService: background removal failed — ${msg}`);
    }
  }
}