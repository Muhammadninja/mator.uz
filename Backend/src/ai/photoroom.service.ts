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

// One combined /v2/edit call (removeBackground + beautify) is fast; cap the
// wait and fail fast rather than stalling for minutes. No silent retries — a
// single retry on a slow endpoint was the main multi-minute stall.
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 1;

// ── AI Upscale (optional pre-stage before background removal) ────────────────
// Defaults per spec. Overridable via env (see resolveUpscaleConfig):
//   AI_UPSCALE_ENABLED=true
//   AI_UPSCALE_MIN_LONG_SIDE=2000          → long side ≥ this ⇒ SKIP upscale
//   AI_UPSCALE_ALWAYS_UPSCALE_BELOW=1200   → long side < this ⇒ ALWAYS upscale
//   AI_UPSCALE_MODE=ai.fast                → Photoroom upscale.mode
// Decision (see shouldUpscale): long side ≥ MIN_LONG_SIDE ⇒ skip; otherwise
// upscale (both the <1200 and 1200–2000 ranges upscale — kept explicit so the
// two bands can diverge later without touching call sites).
const AI_UPSCALE_ENABLED_DEFAULT = true;
const AI_UPSCALE_MIN_LONG_SIDE_DEFAULT = 2000;
const AI_UPSCALE_ALWAYS_UPSCALE_BELOW_DEFAULT = 1200;
const AI_UPSCALE_MODE_DEFAULT = 'ai.fast';
// Photoroom-supported upscale modes. Invalid config falls back to the default.
const AI_UPSCALE_MODES = ['ai.fast', 'ai.slow'] as const;

export interface UpscaleConfig {
  enabled: boolean;
  minLongSide: number;
  alwaysUpscaleBelow: number;
  mode: string;
}

/**
 * Resolve the AI-Upscale config from environment variables, with the spec
 * defaults and light validation. Invalid numeric values fall back to their
 * default; an unsupported mode falls back to ai.fast. `warn` receives a message
 * for each invalid value (so the caller can log via its own logger).
 */
export function resolveUpscaleConfig(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = () => {},
): UpscaleConfig {
  const parseIntEnv = (raw: string | undefined, def: number, name: string): number => {
    if (raw === undefined || raw.trim() === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      warn(`Invalid ${name}="${raw}" (expected a positive integer); using ${def}.`);
      return def;
    }
    return n;
  };

  const enabled =
    env.AI_UPSCALE_ENABLED === undefined
      ? AI_UPSCALE_ENABLED_DEFAULT
      : env.AI_UPSCALE_ENABLED !== 'false';

  const rawMode = env.AI_UPSCALE_MODE;
  let mode = AI_UPSCALE_MODE_DEFAULT;
  if (rawMode !== undefined && rawMode.trim() !== '') {
    if ((AI_UPSCALE_MODES as readonly string[]).includes(rawMode)) {
      mode = rawMode;
    } else {
      warn(
        `Invalid AI_UPSCALE_MODE="${rawMode}" (expected one of ${AI_UPSCALE_MODES.join(', ')}); ` +
          `using ${AI_UPSCALE_MODE_DEFAULT}.`,
      );
    }
  }

  return {
    enabled,
    minLongSide: parseIntEnv(env.AI_UPSCALE_MIN_LONG_SIDE, AI_UPSCALE_MIN_LONG_SIDE_DEFAULT, 'AI_UPSCALE_MIN_LONG_SIDE'),
    alwaysUpscaleBelow: parseIntEnv(
      env.AI_UPSCALE_ALWAYS_UPSCALE_BELOW,
      AI_UPSCALE_ALWAYS_UPSCALE_BELOW_DEFAULT,
      'AI_UPSCALE_ALWAYS_UPSCALE_BELOW',
    ),
    mode,
  };
}

/**
 * Decide whether AI Upscale should run for an image with the given long side.
 *  • long side ≥ minLongSide            → skip (already high-res).
 *  • long side < alwaysUpscaleBelow     → upscale (low-res).
 *  • alwaysUpscaleBelow ≤ ls < minLongSide → upscale (mid-res band).
 * The two sub-2000 bands both upscale today, but are kept as an explicit branch
 * so they can diverge later. Disabled config always returns false.
 */
export function shouldUpscale(longSide: number, cfg: UpscaleConfig): boolean {
  if (!cfg.enabled) return false;
  if (longSide >= cfg.minLongSide) return false;
  if (longSide < cfg.alwaysUpscaleBelow) return true;
  return true;
}

/**
 * Pipeline (детерминированный, единый для всех изображений каталога):
 *   original seller photo
 *     0. (optional) Photoroom upscale → AI Upscale для низко-/среднеразрешённых
 *                                      фото (по длинной стороне); на неудаче —
 *                                      исходник. Фото ≥2000px не апскейлятся.
 *     1. Photoroom /v2/edit          → ТОЛЬКО removeBackground → прозрачный PNG
 *     2. localBeautify (Sharp)       → тон/цвет-коррекция RGB (normalize/gamma/
 *                                      modulate) + дефриндж альфы, БЕЗ AI
 *     3. object detection (bbox)     → trim прозрачной рамки (Sharp)
 *     4. scale to ~80% canvas        → объект вписывается в OBJECT_RATIO_TARGET
 *     5. center on canvas            → одинаковые отступы
 *     6. apply Mator background      → композитинг → 1000×1000
 *     7. final sharpen (Sharp)       → лёгкая резкость на готовом кадре
 *     → save (вызывающий код заливает в Cloudinary)
 *
 * AI Upscale убран намеренно: выход — 1000px, а телефонные фото уже крупнее, так
 * что апскейл с последующим даунскейлом только тратил время без выигрыша.
 *
 * AI Beautify (beautify.mode) убран намеренно: добавлял ~17–19 с к запросу при
 * выигрыше, который воспроизводится локально. Финиш — детерминированно через
 * Sharp (localBeautify + final sharpen). Photoroom используется СТРОГО для
 * вырезания фона; он НЕ генерирует фон, тени, студию и не меняет геометрию.
 */
export class PhotoroomService {
  private readonly apiKey: string;

  // Кэш фона в памяти — читаем файл один раз.
  private backgroundCache: Buffer | null = null;

  // AI-Upscale config, resolved once from env (see resolveUpscaleConfig).
  private readonly upscaleConfig: UpscaleConfig;

  constructor() {
    const key = process.env.PHOTOROOM_API_KEY;
    if (!key) throw new Error('PHOTOROOM_API_KEY is not set');
    this.apiKey = key;
    this.upscaleConfig = resolveUpscaleConfig(process.env, (msg) =>
      // eslint-disable-next-line no-console
      console.warn(`PhotoroomService: ${msg}`),
    );
  }

  /**
   * Полный пайплайн обработки фото детали.
   * Возвращает финальное изображение 1000×1000 (PNG) с маркетплейс-фоном.
   */
  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    // 0. (optional) AI Upscale — только для низко-/среднеразрешённых фото; на
    //    неудаче/таймауте возвращает исходник (никогда не роняет загрузку).
    // 1. Вызов Photoroom /v2/edit: ТОЛЬКО removeBackground (beautify убран).
    const source = await this.maybeUpscale(imageBuffer);
    const cutout = await this.callPhotoroomEdit(source);

    // Локальная обработка Sharp (детерминированная, без внешних зависимостей):
    //   assertTransparent   — проверка альфы вырезанного объекта;
    //   localBeautify       — тон/цвет-коррекция RGB + дефриндж альфы;
    //   composeOnBackground — bbox → scale ~80% → center → фон → 1000×1000 →
    //                         финальная резкость.
    await this.assertTransparent(cutout);
    const finished = await this.localBeautify(cutout);
    return this.composeOnBackground(finished);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. PHOTOROOM EDIT (single call: remove background + beautify)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Один запрос к /v2/edit, выполняющий и удаление фона, и AI-бьютификацию.
   * Обязательный шаг: при неудаче бросает (нет смысла продолжать без выреза).
   * Возвращает сырой прозрачный PNG (проверка альфы — отдельным шагом Sharp у
   * вызывающего кода, чтобы сетевое время не смешивалось с локальным).
   */
  private async callPhotoroomEdit(imageBuffer: Buffer): Promise<Buffer> {
    const result = await this.callPhotoroom(
      () => {
        const form = new FormData();
        form.append('imageFile', imageBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
        form.append('removeBackground', 'true');
        // beautify.mode УБРАН намеренно: AI-бьютификатор добавлял ~17–19 с к
        // запросу (removeBackground один — ~1.5 с). Всю финишную обработку теперь
        // делаем локально через Sharp (localBeautify + финальный sharpen), без AI.
        // PNG обязателен — только он несёт alpha-канал.
        form.append('format', 'png');
        return form;
      },
      'edit (removeBackground)',
      { required: true },
    );
    return result!;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 0. AI UPSCALE (optional pre-stage, conditional on image dimensions)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Optionally AI-upscale the ORIGINAL image before background removal. Reads the
   * dimensions via Sharp metadata only (no decode/resize) to compute the long
   * side, then applies the configured thresholds (see shouldUpscale). Upscales
   * only when required; images ≥ minLongSide never touch the Upscale API.
   *
   * Best-effort: if metadata can't be read, or the Upscale call fails/times out,
   * the ORIGINAL buffer is returned so the product upload always proceeds.
   */
  private async maybeUpscale(imageBuffer: Buffer): Promise<Buffer> {
    if (!this.upscaleConfig.enabled) return imageBuffer;

    let longSide: number;
    try {
      const meta = await sharp(imageBuffer).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      longSide = Math.max(width, height);
      if (longSide === 0) return imageBuffer; // unknown dimensions → skip safely
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `PhotoroomService: could not read image metadata for upscale decision — ${err instanceof Error ? err.message : String(err)}`,
      );
      return imageBuffer;
    }

    if (!shouldUpscale(longSide, this.upscaleConfig)) return imageBuffer;

    const upscaled = await this.upscaleImage(imageBuffer);
    // Soft-fail: on any Upscale failure keep the original (upscaleImage logged it).
    return upscaled ?? imageBuffer;
  }

  /**
   * Single Photoroom /v2/edit call requesting ONLY AI upscale (upscale.mode).
   * Non-required → returns null on failure/timeout so maybeUpscale can fall back
   * to the original image. Output format is JPEG here: the upscaled image is fed
   * back into the removeBackground call (which needs a plain photo, not alpha).
   */
  private async upscaleImage(imageBuffer: Buffer): Promise<Buffer | null> {
    return this.callPhotoroom(
      () => {
        const form = new FormData();
        form.append('imageFile', imageBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
        form.append('upscale.mode', this.upscaleConfig.mode);
        form.append('format', 'jpg');
        return form;
      },
      `upscale (${this.upscaleConfig.mode})`,
      { required: false },
    );
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

  /**
   * Локальная тон/цвет-коррекция вырезанного объекта — замена AI-бьютификатора,
   * консервативная и естественная (детали не должны выглядеть «обработанными AI»).
   * Оптимизировано под автозапчасти, снятые на простом фоне: как правило это
   * тускловатые, слегка недоэкспонированные телефонные фото металла/пластика.
   *
   * ВАЖНО по порядку операций:
   *  • Тон/цвет применяем ЗДЕСЬ (до масштабирования), т.к. это поточечные
   *    операции — результат не зависит от разрешения.
   *  • Резкость сюда НЕ ставим: раньше sharpen стоял до resize в composeOnBackground,
   *    и ресемплинг «съедал» её. Финальный sharpen теперь на готовом 1000×1000
   *    (см. composeOnBackground), где он и виден.
   *
   * Операции идут ПРЯМО по RGBA: normalise/gamma/modulate в Sharp работают по
   * цветовым каналам и оставляют альфу нетронутой, поэтому прозрачность выреза
   * сохраняется естественно — без ручного extract/join альфы.
   */
  private async localBeautify(cutout: Buffer): Promise<Buffer> {
    return sharp(cutout)
      .ensureAlpha()
      // 1) normalize — растягивает гистограмму RGB к полному диапазону. Телефонные
      //    фото деталей почти всегда «сплюснуты» по контрасту (тусклый серый
      //    металл на среднем фоне). Клип 1/99 перцентилей защищает от того, чтобы
      //    один яркий блик или тёмная тень задрали весь контраст (без него
      //    хромированные блики выбивали бы белым).
      .normalise({ lower: 1, upper: 99 })
      // 2) gamma 1.05 — лёгкое осветление средних тонов. Детали часто чуть
      //    недоэкспонированы; gamma поднимает тени/полутени, не пережигая яркие
      //    блики (в отличие от простого brightness), сохраняя объём металла.
      .gamma(1.05)
      // 3) modulate — очень слабый подъём яркости и насыщенности. 1.03/1.05
      //    оживляет цвет краски/маркировок и делает металл менее «грязным», но
      //    остаётся в пределах естественного — крашеные детали не «кислотят».
      .modulate({ brightness: 1.03, saturation: 1.05 })
      // 4) median(1) — лёгкий дефриндж полупрозрачной «бахромы» по контуру выреза
      //    (артефакт сегментации). Радиус 1 не размывает деталь, чистит только
      //    1-пиксельную кромку. Геометрию не трогает.
      .median(1)
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
    const composited = await sharp(background)
      .composite([{ input: resizedObject, left, top }])
      .toBuffer();

    // 8. Финальная резкость — ЕДИНСТВЕННЫЙ sharpen в пайплайне, и он здесь
    //    намеренно: на уже готовом 1000×1000, ПОСЛЕ resize, поэтому ресемплинг
    //    его не размывает (раньше sharpen стоял до масштабирования и почти терялся).
    //    Объект непрозрачный и лежит на матовом фоне, так что резкость по краю
    //    выреза не даёт ореолов на прозрачности.
    //
    //    Параметры подобраны консервативно, чтобы металл/пластик выглядел чётким,
    //    но не «перешарпленным»:
    //      sigma 0.8 — небольшой радиус: подчёркивает реальную микротекстуру
    //                  (резьба, литьё, маркировка), а не создаёт кайму;
    //      m1 0.5    — приглушаем усиление в плоских областях (ровная краска, фон),
    //                  чтобы не лезли шум и «зерно»;
    //      m2 1.5    — умеренное усиление на кромках (где и нужна чёткость);
    //                  низкое значение защищает от гало по контуру детали.
    return sharp(composited)
      .sharpen({ sigma: 0.8, m1: 0.5, m2: 1.5 })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
}
