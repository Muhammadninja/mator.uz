import axios from 'axios';
import FormData from 'form-data';
import { readFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const PHOTOROOM_ENDPOINT = 'https://image-api.photoroom.com/v2/edit';

// Локальный маркетплейс-фон. Только этот файл — никаких AI-фонов/студий/промптов.
const BACKGROUND_PATH = path.join(__dirname, 'assets', '6.jpeg');

// Финальный размер выходного изображения (квадрат маркетплейса).
const OUTPUT_SIZE = 1000;

// Объект должен занимать 75–85% площади кадра. Берём середину диапазона как
// целевую долю; фактический bounding box объекта вписывается в этот квадрат,
// что гарантирует визуально одинаковый размер деталей во всём каталоге.
const OBJECT_RATIO_MIN = 0.75;
const OBJECT_RATIO_MAX = 0.85;
const OBJECT_RATIO_TARGET = (OBJECT_RATIO_MIN + OBJECT_RATIO_MAX) / 2; // 0.80

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 2;

/**
 * Pipeline (детерминированный, единый для всех изображений каталога):
 *   original seller photo
 *     1. Photoroom AI upscale        → повышение разрешения исходного фото
 *     2. Photoroom AI beautify       → улучшение качества (beautify.mode=ai.auto)
 *     3. Photoroom removeBackground  → прозрачный PNG (вырезание объекта)
 *     4. object detection (bbox)     → trim прозрачной рамки (Sharp)
 *     5. scale to ~80% canvas        → объект вписывается в OBJECT_RATIO_TARGET
 *     6. center on canvas            → одинаковые отступы
 *     7. apply Mator background      → композитинг + resize 1000×1000
 *     → save (вызывающий код заливает в Cloudinary)
 *
 * Photoroom используется СТРОГО для AI-операций (upscale, beautify, вырезание).
 * Он НЕ генерирует фон, не рисует тени/отражения/студию, не меняет композицию и
 * геометрию. Фон и размещение — локально через Sharp.
 *
 * Шаги 1–2 деградируют мягко: если Photoroom-улучшение не удалось, используем
 * предыдущий буфер, чтобы единичный сбой не ронял весь пайплайн загрузки.
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
   * Возвращает финальное изображение 1000×1000 (PNG) с маркетплейс-фоном.
   * Имя метода сохранено для обратной совместимости с вызывающим кодом.
   */
  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    // Pipeline order: AI Upscale → AI Beautify → Remove Background →
    //   Object detection → Scale 80% → Center → Apply Mator background → Save.
    // Upscale/Beautify run on the ORIGINAL photo (with background) so the AI
    // works on the full-resolution source before the object is cut out.

    // 1. AI upscale on the original photo (мягкая деградация при сбое).
    const upscaled = await this.aiUpscale(imageBuffer);

    // 2. AI beautify on the upscaled photo (мягкая деградация при сбое).
    const beautifiedAi = await this.aiBeautify(upscaled);

    // 3. Remove background — вырезаем объект, прозрачный PNG (обязательный шаг).
    const cutout = await this.cutout(beautifiedAi);

    // 3b. Локальная чистка краёв альфы вырезанного объекта (детерминированно,
    //     без зависимости от внешнего сервиса) — перед измерением bbox.
    const finished = await this.localBeautify(cutout);

    // 4–7. object detection (bbox) → scale 80% → center → Mator background →
    //      1000×1000 → save (вызывающий код заливает результат в Cloudinary).
    return this.composeOnBackground(finished);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. REMOVE BACKGROUND
  // ──────────────────────────────────────────────────────────────────────────

  private buildCutoutForm(imageBuffer: Buffer): FormData {
    const form = new FormData();
    form.append('imageFile', imageBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    form.append('removeBackground', 'true');
    // PNG обязателен — только он несёт alpha-канал.
    form.append('format', 'png');
    return form;
  }

  private async cutout(imageBuffer: Buffer): Promise<Buffer> {
    const result = await this.callPhotoroom(
      () => this.buildCutoutForm(imageBuffer),
      'background removal',
      { required: true },
    );
    // На обязательном шаге результат должен быть прозрачным, иначе это ошибка.
    await this.assertTransparent(result!);
    return result!;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. AI UPSCALE
  // ──────────────────────────────────────────────────────────────────────────

  /** Photoroom AI upscale. При сбое возвращает входной буфер без изменений. */
  private async aiUpscale(input: Buffer): Promise<Buffer> {
    const result = await this.callPhotoroom(
      () => {
        const form = new FormData();
        // Работаем над исходным фото (с фоном); Photoroom определяет формат
        // по байтам, имя файла — лишь подсказка.
        form.append('imageFile', input, { filename: 'source.jpg', contentType: 'image/jpeg' });
        // Фон НЕ трогаем здесь — удаление фона выполняется отдельным шагом ниже.
        form.append('removeBackground', 'false');
        // v2/edit upscale.mode ∈ {ai.fast, ai.slow}; 'ai' отвергается API.
        form.append('upscale.mode', 'ai.fast');
        form.append('format', 'png');
        return form;
      },
      'AI upscale',
      { required: false },
    );
    return result ?? input;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. AI BEAUTIFY
  // ──────────────────────────────────────────────────────────────────────────

  /** Photoroom AI beautify/enhance объекта. При сбое возвращает вход. */
  private async aiBeautify(input: Buffer): Promise<Buffer> {
    const result = await this.callPhotoroom(
      () => {
        const form = new FormData();
        // Вход — апскейленное фото (всё ещё с фоном); фон удалим следующим шагом.
        form.append('imageFile', input, { filename: 'source.png', contentType: 'image/png' });
        form.append('removeBackground', 'false');
        // AI Beautifier: параметр называется beautify.mode (не enhance.mode);
        // v2/edit допускает {ai.auto, ai.food, ai.car} — для автозапчастей ai.auto.
        form.append('beautify.mode', 'ai.auto');
        form.append('format', 'png');
        return form;
      },
      'AI beautify',
      { required: false },
    );
    return result ?? input;
  }

  /**
   * Единый вызов Photoroom с retry/timeout. На 4xx повтор не делаем.
   * required=true → бросаем при неудаче; required=false → возвращаем null,
   * чтобы вызывающий шаг мог мягко деградировать.
   */
  private async callPhotoroom(
    buildForm: () => FormData,
    label: string,
    opts: { required: boolean },
  ): Promise<Buffer | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const form = buildForm();
      try {
        const response = await axios.post(PHOTOROOM_ENDPOINT, form, {
          headers: {
            ...form.getHeaders(),
            'x-api-key': this.apiKey,
            Accept: 'image/png, application/json',
          },
          responseType: 'arraybuffer',
          timeout: REQUEST_TIMEOUT_MS,
        });
        return Buffer.from(response.data);
      } catch (error) {
        lastError = error;
        // 4xx — ошибка запроса, повтор не поможет.
        if (axios.isAxiosError(error) && error.response && error.response.status < 500) {
          break;
        }
        if (attempt < MAX_ATTEMPTS) continue;
      }
    }

    const detail = this.errorDetail(lastError);
    if (opts.required) {
      throw new Error(`PhotoroomService: ${label} failed — ${detail}`);
    }
    // Мягкая деградация для необязательных AI-шагов.
    // eslint-disable-next-line no-console
    console.warn(`PhotoroomService: ${label} failed, using previous image — ${detail}`);
    return null;
  }

  private errorDetail(error: unknown): string {
    if (axios.isAxiosError(error) && error.response) {
      const body =
        error.response.data instanceof Buffer
          ? error.response.data.toString('utf8')
          : JSON.stringify(error.response.data);
      return `HTTP ${error.response.status}: ${body}`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** Проверяет, что Photoroom вернул реально прозрачный фон. */
  private async assertTransparent(png: Buffer): Promise<void> {
    const meta = await sharp(png).metadata();
    if (!meta.hasAlpha) {
      throw new Error('PhotoroomService: removeBackground returned an image without an alpha channel');
    }
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
  // 3b. LOCAL FINISH (deterministic, no external dependency)
  // ──────────────────────────────────────────────────────────────────────────

  /** Лёгкая локальная финишная обработка: резкость + чистка краёв альфы. */
  private async localBeautify(cutout: Buffer): Promise<Buffer> {
    return sharp(cutout)
      .ensureAlpha()
      .sharpen({ sigma: 0.7 })
      .median(1) // убираем полупрозрачную «бахрому» по контуру, не трогая геометрию
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4–7. BBOX → SCALE 75–85% → CENTER → MARKETPLACE BACKGROUND
  // ──────────────────────────────────────────────────────────────────────────

  private async getBackground(): Promise<Buffer> {
    if (!this.backgroundCache) {
      const raw = await readFile(BACKGROUND_PATH);
      this.backgroundCache = await sharp(raw)
        .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: 'cover', position: 'centre' })
        .removeAlpha()
        .toBuffer();
    }
    return this.backgroundCache;
  }

  /**
   * Размещает вырезанный объект на маркетплейс-фоне с единообразным размером:
   *  4. bounding box — trim полностью прозрачной рамки (Sharp.trim);
   *  5. scale — объект вписывается в квадрат OBJECT_RATIO_TARGET × OUTPUT_SIZE
   *     (≈80% кадра, в пределах требуемых 75–85%), пропорции сохраняются;
   *  6. center — одинаковые отступы со всех сторон;
   *  7. background — композитинг поверх локального фона, итог 1000×1000.
   *
   * Из-за фиксированной целевой доли (OBJECT_RATIO_TARGET) ВСЕ изображения
   * каталога получают визуально одинаковый размер объекта.
   */
  private async composeOnBackground(objectPng: Buffer): Promise<Buffer> {
    const background = await this.getBackground();
    const box = Math.round(OUTPUT_SIZE * OBJECT_RATIO_TARGET);

    // 4. bounding box: обрезаем прозрачную рамку, чтобы под масштаб попал сам
    //    объект, а не пустое пространство. trim() бросает, если обрезать нечего.
    let trimmed: Buffer;
    try {
      trimmed = await sharp(objectPng).trim().toBuffer();
    } catch {
      trimmed = objectPng;
    }

    // 5. scale: вписываем bbox в box×box с сохранением пропорций. В отличие от
    //    прежней версии разрешаем УВЕЛИЧЕНИЕ (без withoutEnlargement), иначе
    //    мелкие объекты не дотягивали бы до 75–85% и размер был бы непостоянным.
    const resizedObject = await sharp(trimmed)
      .resize(box, box, {
        fit: 'inside',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();

    const { width = box, height = box } = await sharp(resizedObject).metadata();

    // 6. center.
    const left = Math.round((OUTPUT_SIZE - width) / 2);
    const top = Math.round((OUTPUT_SIZE - height) / 2);

    // 7. background.
    return sharp(background)
      .composite([{ input: resizedObject, left, top }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
}
