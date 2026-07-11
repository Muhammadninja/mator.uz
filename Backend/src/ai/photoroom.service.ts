import axios from 'axios';
import FormData from 'form-data';

// PhotoRoom Image Editing API v2 (single edit call).
const PHOTOROOM_ENDPOINT = 'https://image-api.photoroom.com/v2/edit';

// "AI Car" is PhotoRoom's car beautifier (beautify.mode=ai.car): it removes
// reflections and enhances the car/part image. We run it together with
// background removal in ONE /v2/edit call and return the transparent PNG as-is.
const BEAUTIFY_MODE_AI_CAR = 'ai.car';

// PhotoRoom processing may take up to ~30 s; allow generous headroom over that so
// a slow-but-successful job is not cut off by the client timeout. Single attempt
// (no silent retries) — a retry on a slow endpoint only stacks the wait.
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * PhotoroomService — the single, minimal image step for seller uploads.
 *
 * Pipeline (nothing else — no upscale, no resize, no compositing, no local
 * post-processing):
 *   1. receive the uploaded image buffer,
 *   2. send it to PhotoRoom /v2/edit with removeBackground + beautify.mode=ai.car,
 *   3. return the transparent PNG produced by PhotoRoom, exactly as received.
 *
 * The caller uploads the returned buffer to Cloudinary unchanged.
 */
export class PhotoroomService {
  private readonly apiKey: string;

  constructor() {
    const key = process.env.PHOTOROOM_API_KEY;
    if (!key) throw new Error('PHOTOROOM_API_KEY is not set');
    this.apiKey = key;
  }

  /**
   * Send the image to PhotoRoom (remove background + AI Car beautify) and return
   * the transparent PNG it produces, with no further processing. Throws on
   * failure (there is no meaningful fallback — without the cutout there is
   * nothing to upload).
   */
  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    const form = new FormData();
    form.append('imageFile', imageBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    form.append('removeBackground', 'true');
    form.append('beautify.mode', BEAUTIFY_MODE_AI_CAR);
    // PNG carries the alpha channel; it is what we return to the caller as-is.
    form.append('export.format', 'png');

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
      throw new Error(`PhotoroomService: AI Car edit failed — ${this.errorDetail(error)}`);
    }
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
}
