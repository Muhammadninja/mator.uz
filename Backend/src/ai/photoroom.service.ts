import axios from 'axios';
import FormData from 'form-data';
import { readFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const PHOTOROOM_ENDPOINT = 'https://image-api.photoroom.com/v2/edit';

// Локальный фон. Только этот файл — никаких AI-фонов, студий, промптов.
const BACKGROUND_PATH = path.join(__dirname, 'assets', '6.jpeg');

// Финальный размер выходного изображения.
const OUTPUT_SIZE = 1000;

// Доля площади кадра, которую должен занимать объект (70–80%).
// Используем ширину/высоту: объект вписывается в квадрат OBJECT_RATIO × OUTPUT_SIZE.
const OBJECT_RATIO = 0.78;

/**
 * Pipeline:
 *   input photo
 *     → Photoroom removeBackground  (только вырезание объекта)
 *     → PNG с alpha
 *     → beautify объекта (только резкость/края, без теней и фона)
 *     → композитинг поверх локального фона 6.jpeg через Sharp
 *     → resize 1000×1000
 *     → финальное изображение
 *
 * Photoroom используется СТРОГО для удаления фона. Он не генерирует фон,
 * не рисует тени/отражения/студию, не меняет композицию и геометрию.
 */
export class PhotoroomService {
  private readonly apiKey: string;

  // Кэш фона в памяти — читаем файл один раз.
  private backgroundCache: Buffer | null = null;

  constructor() {
    const key = process.env.PHOTOROOM_API_KEY;
    if (!key) throw new Error('PHOTOROOM_API_KEY is not set');
    this.apiKey = key;
  }

  /**
   * Полный пайплайн обработки фото детали.
   * Возвращает финальное изображение 1000×1000 (PNG) с локальным фоном.
   */
  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    // 1. Вырезаем объект — получаем прозрачный PNG.
    const cutout = await this.cutout(imageBuffer);

    // 2. Лёгкая бьютификация ТОЛЬКО объекта (резкость + чистка краёв альфы).
    const beautified = await this.beautifyObject(cutout);

    // 3. Композитинг поверх локального фона + ресайз до 1000×1000.
    const composed = await this.composeOnBackground(beautified);

    return composed;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. REMOVE BACKGROUND
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Запрос к Photoroom строго на удаление фона.
   * Никаких background.prompt / shadow / beautify / outputSize —
   * только вырезанный объект в PNG с alpha-каналом.
   */
  private buildCutoutForm(imageBuffer: Buffer): FormData {
    const form = new FormData();

    form.append('imageFile', imageBuffer, {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    });

    // Удаляем фон.
    form.append('removeBackground', 'true');

    // PNG обязателен — только он несёт alpha-канал.
    form.append('format', 'png');

    return form;
  }

  private async cutout(imageBuffer: Buffer): Promise<Buffer> {
    const MAX_ATTEMPTS = 2;
    const TIMEOUT_MS = 60_000;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const form = this.buildCutoutForm(imageBuffer);
      try {
        const response = await axios.post(PHOTOROOM_ENDPOINT, form, {
          headers: {
            ...form.getHeaders(),
            'x-api-key': this.apiKey,
            Accept: 'image/png, application/json',
          },
          responseType: 'arraybuffer',
          timeout: TIMEOUT_MS,
        });

        const result = Buffer.from(response.data);
        // Гарантируем прозрачный фон, иначе считаем результат ошибкой.
        await this.assertTransparent(result);
        return result;
      } catch (error) {
        lastError = error;

        // 4xx — ошибка запроса, повтор не поможет.
        if (axios.isAxiosError(error) && error.response) {
          const status = error.response.status;
          if (status < 500) {
            const body = Buffer.from(error.response.data).toString('utf8');
            throw new Error(
              `PhotoroomService: background removal failed — HTTP ${status}: ${body}`,
            );
          }
        }

        if (attempt < MAX_ATTEMPTS) continue;
      }
    }

    if (axios.isAxiosError(lastError) && lastError.response) {
      const body = Buffer.from(lastError.response.data).toString('utf8');
      throw new Error(
        `PhotoroomService: background removal failed — HTTP ${lastError.response.status}: ${body}`,
      );
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`PhotoroomService: background removal failed — ${msg}`);
  }

  /**
   * Проверяет, что Photoroom действительно вернул прозрачный фон.
   * Если alpha-канала нет или фон непрозрачный — это ошибка, такой результат
   * использовать нельзя.
   */
  private async assertTransparent(png: Buffer): Promise<void> {
    const meta = await sharp(png).metadata();

    if (!meta.hasAlpha) {
      throw new Error(
        'PhotoroomService: removeBackground returned an image without an alpha channel',
      );
    }

    // Проверяем, что фон реально прозрачный: берём статистику alpha-канала.
    // У вырезанного объекта минимум альфы по краям должен быть близок к 0
    // (полностью прозрачные пиксели). Если минимум высокий — фон не убран.
    const stats = await sharp(png).stats();
    const alpha = stats.channels[stats.channels.length - 1];
    if (alpha.min > 8) {
      throw new Error(
        `PhotoroomService: removeBackground returned a non-transparent background ` +
          `(alpha min=${alpha.min}, max=${alpha.max})`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. BEAUTIFY OBJECT ONLY
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Лёгкое улучшение качества ТОЛЬКО объекта на прозрачном PNG.
   * Делается локально через Sharp — это гарантирует, что не будет добавлено
   * ни теней, ни отражений, ни фона, ни студийного освещения, ни изменения
   * геометрии/материала/формы детали.
   *
   * Только:
   *  - небольшое повышение резкости;
   *  - аккуратная чистка краёв альфы (убрать «ореол» от вырезания).
   */
  private async beautifyObject(cutout: Buffer): Promise<Buffer> {
    return sharp(cutout)
      .ensureAlpha()
      // Лёгкая резкость — деликатные параметры, без агрессии.
      .sharpen({ sigma: 0.7 })
      // Чистка краёв: убираем полупрозрачную «бахрому» по контуру объекта,
      // не трогая саму геометрию. median сглаживает alpha-шум на границе.
      .median(1)
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. COMPOSITE ON LOCAL BACKGROUND + RESIZE 1000×1000
  // ──────────────────────────────────────────────────────────────────────────

  private async getBackground(): Promise<Buffer> {
    if (!this.backgroundCache) {
      // Готовим фон один раз: ресайз до 1000×1000 (cover), без альфы.
      const raw = await readFile(BACKGROUND_PATH);
      this.backgroundCache = await sharp(raw)
        .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'cover', position: 'centre' })
        .removeAlpha()
        .toBuffer();
    }
    return this.backgroundCache;
  }

  /**
   * Размещает вырезанный объект по центру локального фона.
   *  - объект полностью помещается в кадр (не обрезается);
   *  - пропорции сохраняются;
   *  - занимает ~70–80% площади (вписан в OBJECT_RATIO × OUTPUT_SIZE);
   *  - не масштабируется сверх оригинала (withoutEnlargement);
   *  - одинаковые отступы (центрирование).
   */
  private async composeOnBackground(objectPng: Buffer): Promise<Buffer> {
    const background = await this.getBackground();

    const box = Math.round(OUTPUT_SIZE * OBJECT_RATIO);

    // Photoroom возвращает объект на исходном полнокадровом холсте с большими
    // прозрачными полями. Обрезаем полностью прозрачную рамку, чтобы под ресайз
    // попал именно объект (его bounding box), а не пустое пространство —
    // иначе деталь окажется мелкой и не займёт нужные 70–80%.
    // trim() бросает исключение, если обрезать нечего (однотонный кадр) —
    // в этом случае используем объект как есть.
    let trimmed: Buffer;
    try {
      trimmed = await sharp(objectPng).trim().toBuffer();
    } catch {
      trimmed = objectPng;
    }

    // Вписываем объект в квадрат box×box с сохранением пропорций.
    // Деталь полностью помещается в кадр и не обрезается (fit: 'inside').
    // withoutEnlargement: не увеличиваем объект сверх его оригинального размера.
    const resizedObject = await sharp(trimmed)
      .resize(box, box, {
        fit: 'inside',
        withoutEnlargement: true,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();

    const { width = box, height = box } = await sharp(resizedObject).metadata();

    // Центрируем объект на фоне (одинаковые отступы со всех сторон).
    const left = Math.round((OUTPUT_SIZE - width) / 2);
    const top = Math.round((OUTPUT_SIZE - height) / 2);

    return sharp(background)
      .composite([{ input: resizedObject, left, top }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
}
