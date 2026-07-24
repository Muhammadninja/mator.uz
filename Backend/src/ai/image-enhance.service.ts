import { Injectable } from '@nestjs/common';
import axios from 'axios';

// Black Forest Labs FLUX.2 Max — the highest-quality model in the FLUX.2 family.
// The API is asynchronous: POST the edit request, receive a polling_url, then GET
// that url until the job is Ready (or errors), and finally download the produced
// image from the signed result URL. Endpoint and parameter names below are taken
// from the official BFL API schema (Flux2Inputs) — not assumed.
const FLUX_ENDPOINT = 'https://api.bfl.ai/v1/flux-2-max';

// Target canvas. FLUX.2 accepts explicit width/height (nullable ints, min 64) to
// fix the output resolution; there is no aspect_ratio field, so this is how the
// exact 1000×1000 output is requested. The prompt handles composition inside it
// (centered, ~85–90% fill, even margins) — width/height only set the canvas.
const OUTPUT_WIDTH = 1000;
const OUTPUT_HEIGHT = 1000;

// The single prompt used for every request. It treats the input as ground truth
// and demands a DOCUMENTARY result (same object, better camera/lighting), not an
// idealized product render: place the part on a pure white background, centered
// and scaled to ~85–90% of the 1000×1000 canvas, and improve only *global* image
// quality — deliberately no "sharpness", so the model does not read it as license
// to reconstruct detail. Only background pixels may change; the object is
// immutable (every part pixel stays visually identical apart from global
// lighting/color). Every text/logo/marking is factual evidence and must
// stay exactly as-is (blurry stays blurry; incorrect text is worse than blurry).
// Accuracy has absolute priority over aesthetics: on any conflict, preserve the
// original. This is not a restoration or generation task. Intentionally strict;
// do not soften it.
const FLUX_PROMPT =
  'Create a professional automotive marketplace product photograph from the input image.\n\n' +
  'The output image must be exactly 1000×1000 pixels with a pure white (#FFFFFF) background.\n\n' +
  'The automotive part must remain the exact same physical object.\n\n' +
  'CRITICAL REQUIREMENTS\n\n' +
  'This is NOT a restoration task.\n' +
  'This is NOT a reconstruction task.\n' +
  'This is NOT a generation task.\n\n' +
  'Treat the input image as the ground truth.\n\n' +
  'Preserve exactly:\n\n' +
  '- object geometry\n' +
  '- proportions\n' +
  '- dimensions\n' +
  '- orientation\n' +
  '- perspective\n' +
  '- position\n' +
  '- surface texture\n' +
  '- scratches\n' +
  '- wear marks\n' +
  '- dirt\n' +
  '- manufacturing defects\n' +
  '- edges\n' +
  '- holes\n' +
  '- connectors\n' +
  '- mounting points\n' +
  '- reflections\n\n' +
  'TEXT AND LOGOS\n\n' +
  'Any visible text, logo, engraving, serial number, barcode, QR code, OEM number, GM number, ' +
  'label, sticker, embossing, stamping or printed marking MUST remain EXACTLY as it appears in ' +
  'the original image.\n\n' +
  'If any text or marking is blurry, partially visible, damaged or unreadable, KEEP IT BLURRY.\n\n' +
  'Never sharpen unreadable text into readable text.\n\n' +
  'Never reconstruct letters.\n\n' +
  'Never guess missing characters.\n\n' +
  'Never invent logos.\n\n' +
  'Never redraw engravings.\n\n' +
  'Never redraw labels.\n\n' +
  'Never redraw stickers.\n\n' +
  'Never replace text with cleaner text.\n\n' +
  'Never increase text resolution by hallucinating characters.\n\n' +
  'If a marking cannot be recovered from the original pixels, leave it unchanged.\n\n' +
  'TEXT IS EVIDENCE\n\n' +
  'Treat every visible character, number, logo, engraving, label, sticker, barcode, QR code, ' +
  'embossing and OEM marking as factual evidence from the original photograph.\n\n' +
  'Never improve, restore, redraw, reconstruct, infer, estimate or complete any textual ' +
  'information.\n\n' +
  'If any character is not fully visible, leave it exactly as it appears.\n\n' +
  'Incorrect text is worse than blurry text.\n\n' +
  'IMAGE QUALITY\n\n' +
  'Improve only perceived global image quality without generating or reconstructing local ' +
  'details.\n\n' +
  'Improve only:\n\n' +
  '- global lighting\n' +
  '- exposure\n' +
  '- white balance\n' +
  '- color accuracy\n' +
  '- global contrast\n' +
  '- image noise\n\n' +
  'Do not increase local detail by generating new pixels.\n\n' +
  'Do not reconstruct missing high-frequency details.\n\n' +
  'Do not perform local reconstruction.\n\n' +
  'Do not synthesize details.\n\n' +
  'Do not hallucinate textures.\n\n' +
  'Do not generate missing pixels.\n\n' +
  'OBJECT INTEGRITY\n\n' +
  'The automotive part is immutable.\n\n' +
  'Treat it as a photographed physical object, not a generated object.\n\n' +
  'Do not reinterpret its appearance.\n\n' +
  'Do not redesign any feature.\n\n' +
  'Do not replace low-quality regions with newly generated content.\n\n' +
  'Preserve every visible physical feature exactly as photographed.\n\n' +
  'BACKGROUND\n\n' +
  'Replace only the background.\n\n' +
  'The object itself is immutable.\n\n' +
  'Only pixels that belong to the background may be modified.\n\n' +
  'Every pixel belonging to the automotive part must remain visually identical unless changed ' +
  'solely by global lighting or global color correction.\n\n' +
  'Make the new background a pure white (#FFFFFF) studio background.\n\n' +
  'Center the object.\n\n' +
  'Scale it to occupy approximately 85–90% of the canvas while preserving its original aspect ratio.\n\n' +
  'OUTPUT STYLE\n\n' +
  'The result must remain a documentary photograph of the original object.\n\n' +
  'It must not become an idealized or reconstructed product image.\n\n' +
  'The image should look like the original photograph taken with a better camera under better ' +
  'lighting.\n\n' +
  'WHEN UNCERTAIN\n\n' +
  'When uncertain, copy the original appearance instead of improving it.\n\n' +
  'If preserving the original pixels and improving the image are in conflict, ALWAYS choose ' +
  'preserving the original.\n\n' +
  'Accuracy has absolute priority over aesthetics. If any requested enhancement conflicts with ' +
  'preserving the original object exactly, preserve the original. Never sacrifice factual ' +
  'accuracy for visual quality.\n\n' +
  'The ideal output is indistinguishable from the original photograph except for:\n\n' +
  '- cleaner background\n' +
  '- better global lighting\n' +
  '- lower image noise\n' +
  '- better global color balance\n\n' +
  'Nothing else should appear changed.';

// Output container. The result is an opaque image on a white background (no alpha
// is requested or relied on). PNG keeps the white background lossless; the caller
// uploads it to Cloudinary as-is.
const OUTPUT_FORMAT = 'png';

// Timeouts. The submit and each poll GET are quick HTTP calls; the actual
// generation happens on FLUX's side and is observed through polling. Signed
// result URLs are only valid for ~10 minutes, so the whole job must finish well
// inside that — we cap the polling wall-clock at 4 minutes.
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_WAIT_MS = 240_000;

interface SubmitResponse {
  id?: string;
  polling_url?: string;
}

interface PollResponse {
  status?: string;
  result?: { sample?: string } | null;
}

/**
 * ImageEnhanceService — the single, minimal image step for seller uploads,
 * backed by Black Forest Labs FLUX.2 Max.
 *
 * Pipeline (nothing else — no local resize, compositing, or post-processing):
 *   1. receive the uploaded image buffer,
 *   2. submit it to FLUX.2 Max (base64) with the preservation prompt,
 *      output_format=png, and width=height=1000, asking for the part centered
 *      on a pure white background,
 *   3. poll until the job is Ready, download the produced 1000×1000 PNG,
 *   4. return that PNG buffer, exactly as received from FLUX.
 *
 * The caller uploads the returned buffer to Cloudinary unchanged.
 */
@Injectable()
export class ImageEnhanceService {
  private readonly apiKey: string;

  constructor() {
    const key = process.env.BFL_API_KEY;
    if (!key) throw new Error('BFL_API_KEY is not set');
    this.apiKey = key;
  }

  /**
   * Produce a 1000×1000 professional product photo of the part on a pure white
   * background via FLUX.2 Max, returning the PNG it produces with no further
   * processing. Throws on failure (there is no meaningful fallback — without the
   * processed image there is nothing to upload).
   *
   * Name kept as removeBackground for a drop-in swap with the previous provider:
   * the caller's contract (Buffer in → processed PNG Buffer out) is unchanged,
   * even though the result is now on a white background rather than transparent.
   */
  async removeBackground(imageBuffer: Buffer): Promise<Buffer> {
    try {
      const pollingUrl = await this.submit(imageBuffer);
      const imageUrl = await this.pollForResult(pollingUrl);
      return await this.download(imageUrl);
    } catch (error) {
      throw new Error(
        `ImageEnhanceService: FLUX.2 Max edit failed — ${this.errorDetail(error)}`,
      );
    }
  }

  /** Submit the edit request; returns the polling URL for this job. */
  private async submit(imageBuffer: Buffer): Promise<string> {
    const response = await axios.post<SubmitResponse>(
      FLUX_ENDPOINT,
      {
        prompt: FLUX_PROMPT,
        input_image: imageBuffer.toString('base64'),
        width: OUTPUT_WIDTH,
        height: OUTPUT_HEIGHT,
        output_format: OUTPUT_FORMAT,
      },
      {
        headers: {
          'x-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: SUBMIT_TIMEOUT_MS,
      },
    );

    const pollingUrl = response.data?.polling_url;
    if (!pollingUrl) {
      throw new Error(
        `no polling_url in submit response: ${JSON.stringify(response.data)}`,
      );
    }
    return pollingUrl;
  }

  /**
   * Poll the job until it is Ready and return the signed result image URL.
   * Throws on a terminal error status or if the job does not finish within
   * MAX_POLL_WAIT_MS.
   */
  private async pollForResult(pollingUrl: string): Promise<string> {
    const deadline = Date.now() + MAX_POLL_WAIT_MS;

    for (;;) {
      const response = await axios.get<PollResponse>(pollingUrl, {
        headers: { 'x-key': this.apiKey, Accept: 'application/json' },
        timeout: POLL_TIMEOUT_MS,
      });

      const status = response.data?.status;
      if (status === 'Ready') {
        const sample = response.data?.result?.sample;
        if (!sample) {
          throw new Error(
            `Ready status without result.sample: ${JSON.stringify(response.data)}`,
          );
        }
        return sample;
      }

      // Terminal failure states — anything that is not a known "still working"
      // status is treated as a hard error rather than polled forever.
      if (
        status !== 'Pending' &&
        status !== 'Reasoning' &&
        status !== 'Generating'
      ) {
        throw new Error(`job did not succeed (status=${status ?? 'unknown'})`);
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `job not Ready within ${MAX_POLL_WAIT_MS}ms (last status=${status})`,
        );
      }
      await delay(POLL_INTERVAL_MS);
    }
  }

  /** Download the produced PNG from the signed result URL. */
  private async download(imageUrl: string): Promise<Buffer> {
    const response = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
    return Buffer.from(response.data);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
