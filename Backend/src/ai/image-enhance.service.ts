import { Injectable } from '@nestjs/common';
import axios, { type AxiosResponse } from 'axios';
import { type BflConfig, resolveBflConfig } from './bfl.config';

// Black Forest Labs FLUX 3 Image (model from BFL_FLUX_MODEL, see bfl.config.ts).
// One endpoint serves generation and editing; an edit is the prompt plus the
// source photo in `images`. The API is asynchronous: POST the request, receive a
// polling_url, then GET that url until the job is Ready (or errors), and finally
// download the produced image from the signed result URL. Field names below are
// taken from the official BFL API schema (Flux3ImageInputs) — not assumed. That
// schema rejects unknown fields with 422, so FLUX.2's input_image / width /
// height / output_format must not be sent.

// Target canvas. FLUX 3 has no width/height: the size is an aspect ratio plus an
// equal-pixel-area resolution tier, and BFL picks the exact pixels for the tier.
// 1:1 at `1k` (about 1 MP) is the tier closest to the previous exact 1000×1000.
// The prompt handles composition inside it (centered, ~85–90% fill, even
// margins) — these two only set the canvas.
const OUTPUT_ASPECT_RATIO = '1:1';
const OUTPUT_RESOLUTION = '1k';

// FLUX 3 grounds the prompt in web and image search unless told not to. Here the
// seller's photo is the only source of truth: a looked-up picture of "the same"
// part is exactly what the prompt forbids (invented logos, redrawn markings), so
// grounding is off — which is how FLUX.2 [pro] behaved, having no such feature.
const GROUNDING = false;

// The single prompt used for every request. It treats the input as ground truth
// and demands a DOCUMENTARY result (same object, better camera/lighting), not an
// idealized product render: place the part on a pure white background, centered
// and scaled to ~85–90% of the square canvas, and improve only *global* image
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
  'The output image must be square (1:1) with a pure white (#FFFFFF) background.\n\n' +
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

// Output container: FLUX 3 Image always returns PNG (there is no output_format
// field). The result is an opaque image on a white background (no alpha is
// requested or relied on); the caller uploads it to Cloudinary as-is.

// Timeouts. The submit and each poll GET are quick HTTP calls; the actual
// generation happens on BFL's side and is observed through polling. The signed
// result URL is short-lived, so it is downloaded the moment the job is Ready, and
// the polling wall-clock is capped at 4 minutes so a stuck job fails (and goes to
// the queue's bounded retry) instead of holding a worker slot indefinitely.
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_WAIT_MS = 240_000;

// One failed poll GET does not stop the job on BFL's side, so a transient poll
// error is retried in place, up to this many in a row, instead of failing the
// attempt — which would resubmit and pay for a second generation.
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

// Error bodies end up in the stored failure (last_error, BullMQ's failed set);
// capped so an HTML error page cannot bloat either.
const MAX_ERROR_BODY_CHARS = 500;

// Poll statuses that mean "still working" — keep polling.
const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
  'Pending',
  'Reasoning',
  'Generating',
]);

// Every task status BFL documents for a poll. A 503 body counts as a task answer
// only when it carries one of these; anything else there is an outage.
const TASK_STATUSES: ReadonlySet<string> = new Set([
  ...IN_PROGRESS_STATUSES,
  'Ready',
  'Request Moderated',
  'Content Moderated',
  'Error',
  'Task not found',
]);

// Terminal statuses a resubmit of the same photo would only repeat: moderation
// flagged the INPUT before generation started. The other failures — Content
// Moderated (the generated output was flagged), Error, Task not found — can
// succeed on a fresh generation, so they stay retryable (but see below).
const PERMANENT_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'Request Moderated',
]);

// The same for a task status delivered as HTTP 503. BFL: "A failed task can come
// back as HTTP 503 with a normal JSON body. Read status from the body before
// treating a 503 as a retryable outage." A task Error reported that way is
// final too; a 200 Error keeps its retry.
const PERMANENT_FAILURE_STATUSES_ON_503: ReadonlySet<string> = new Set([
  ...PERMANENT_FAILURE_STATUSES,
  'Error',
]);

// Operator hints for statuses whose cause sits with our BFL account, so the
// server log says what to fix without ever printing the key itself.
const STATUS_HINTS: Readonly<Record<number, string>> = {
  401: 'BFL rejected the API key, check BFL_API_KEY',
  402: 'BFL account is out of credits',
  403: 'BFL API key may not use this model, check BFL_API_KEY / BFL_FLUX_MODEL',
  429: 'BFL rate limit, too many active tasks on this account',
};

type Phase = 'submit' | 'poll' | 'download';

interface SubmitResponse {
  id?: string;
  polling_url?: string;
}

interface PollResponse {
  status?: string;
  result?: { sample?: string } | null;
}

/**
 * A failed FLUX call. `retryable` says whether running the job again can help:
 * false for what a resubmit would only repeat (key rejected, no credits, request
 * invalid, input moderated, a task Error reported as HTTP 503), true for
 * transient failures (timeouts, network errors, 429, 5xx, a failed generation,
 * a malformed response). The message is safe to log and to store — it never
 * contains the API key.
 */
export class ImageEnhanceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ImageEnhanceError';
  }
}

/**
 * ImageEnhanceService — the single, minimal image step for seller uploads,
 * backed by Black Forest Labs FLUX 3 Image.
 *
 * Pipeline (nothing else — no local resize, compositing, or post-processing):
 *   1. receive the uploaded image buffer,
 *   2. submit it to FLUX 3 Image (base64, in `images`) with the preservation
 *      prompt, aspect_ratio=1:1, resolution=1k and grounding off, asking for the
 *      part centered on a pure white background,
 *   3. poll until the job is Ready, download the produced square PNG,
 *   4. return that PNG buffer, exactly as received from FLUX.
 *
 * The caller uploads the returned buffer to Cloudinary unchanged.
 */
@Injectable()
export class ImageEnhanceService {
  private readonly config: BflConfig;

  constructor() {
    this.config = resolveBflConfig(process.env);
  }

  /**
   * Produce a square professional product photo of the part on a pure white
   * background via FLUX 3 Image, returning the PNG it produces with no further
   * processing. Throws an {@link ImageEnhanceError} on failure (there is no
   * meaningful fallback — without the processed image there is nothing to
   * upload); its `retryable` flag drives the image worker's retry decision.
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
      const detail = error instanceof Error ? error.message : String(error);
      throw new ImageEnhanceError(
        this.redact(
          `ImageEnhanceService: ${this.config.model} edit failed — ${detail}`,
        ),
        // Anything unclassified gets the queue's bounded retry.
        error instanceof ImageEnhanceError ? error.retryable : true,
      );
    }
  }

  /** Submit the edit request; returns the polling URL for this job. */
  private async submit(imageBuffer: Buffer): Promise<string> {
    const response = await httpCall('submit', () =>
      axios.post<SubmitResponse>(
        this.config.endpoint,
        {
          prompt: FLUX_PROMPT,
          images: [imageBuffer.toString('base64')],
          aspect_ratio: OUTPUT_ASPECT_RATIO,
          resolution: OUTPUT_RESOLUTION,
          grounding: GROUNDING,
        },
        {
          headers: {
            'x-key': this.config.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: SUBMIT_TIMEOUT_MS,
        },
      ),
    );

    const pollingUrl = response.data?.polling_url;
    if (typeof pollingUrl !== 'string' || pollingUrl === '') {
      throw new ImageEnhanceError(
        `no polling_url in submit response: ${bodyText(response.data)}`,
        true,
      );
    }
    return pollingUrl;
  }

  /**
   * Poll the job until it is Ready and return the signed result image URL.
   * Throws on a terminal status, on a poll error that is permanent or repeats
   * MAX_CONSECUTIVE_POLL_ERRORS times in a row, or if the job does not finish
   * within MAX_POLL_WAIT_MS.
   */
  private async pollForResult(pollingUrl: string): Promise<string> {
    const deadline = Date.now() + MAX_POLL_WAIT_MS;
    let lastStatus = 'none';
    let pollErrors = 0;

    for (;;) {
      const response = await this.poll(pollingUrl).catch((error: unknown) => {
        pollErrors += 1;
        const transient = error instanceof ImageEnhanceError && error.retryable;
        if (transient && pollErrors < MAX_CONSECUTIVE_POLL_ERRORS) return null;
        throw error;
      });

      if (response) {
        pollErrors = 0;
        const status = response.data?.status;
        if (status === 'Ready') return readySample(response.data);
        // Anything that is not a known "still working" status is terminal
        // rather than polled forever.
        if (status === undefined || !IN_PROGRESS_STATUSES.has(status)) {
          const on503 = response.status === 503;
          const permanent = on503
            ? PERMANENT_FAILURE_STATUSES_ON_503
            : PERMANENT_FAILURE_STATUSES;
          throw new ImageEnhanceError(
            `job did not succeed (status=${status ?? 'unknown'}` +
              (on503 ? `, HTTP 503: ${bodyText(response.data)})` : ')'),
            !permanent.has(status ?? ''),
          );
        }
        lastStatus = status;
      }

      if (Date.now() >= deadline) {
        throw new ImageEnhanceError(
          `job not Ready within ${MAX_POLL_WAIT_MS}ms (last status=${lastStatus})`,
          true,
        );
      }
      await delay(POLL_INTERVAL_MS);
    }
  }

  /**
   * One poll GET. A 503 whose body carries a BFL task status is a task answer
   * (see PERMANENT_FAILURE_STATUSES_ON_503) and is returned like any other; only
   * a 503 without one is thrown, as the transient outage it was before.
   */
  private async poll(pollingUrl: string): Promise<AxiosResponse<PollResponse>> {
    const response = await httpCall('poll', () =>
      axios.get<PollResponse>(pollingUrl, {
        headers: { 'x-key': this.config.apiKey, Accept: 'application/json' },
        timeout: POLL_TIMEOUT_MS,
        validateStatus: (code) => (code >= 200 && code < 300) || code === 503,
      }),
    );
    const status: unknown = response.data?.status;
    const taskAnswer = typeof status === 'string' && TASK_STATUSES.has(status);
    if (response.status === 503 && !taskAnswer) {
      throw new ImageEnhanceError(
        `poll HTTP 503: ${bodyText(response.data)}`,
        true,
      );
    }
    return response;
  }

  /** Download the produced PNG from the signed result URL. */
  private async download(imageUrl: string): Promise<Buffer> {
    // A pre-signed delivery URL: deliberately no x-key, which only ever goes
    // to BFL's API.
    const response = await httpCall('download', () =>
      axios.get<ArrayBuffer>(imageUrl, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
      }),
    );
    const image = Buffer.from(response.data);
    if (image.length === 0) {
      throw new ImageEnhanceError('downloaded result image is empty', true);
    }
    return image;
  }

  /** Belt and braces: an error body that echoes the key must not carry it on. */
  private redact(text: string): string {
    return text.replaceAll(this.config.apiKey, '[REDACTED]');
  }
}

/** The signed sample URL of a Ready job, or a retryable error without one. */
function readySample(data: PollResponse): string {
  const sample = data.result?.sample;
  if (typeof sample !== 'string' || sample === '') {
    throw new ImageEnhanceError(
      `Ready status without result.sample: ${bodyText(data)}`,
      true,
    );
  }
  return sample;
}

/** Run one HTTP call, turning its failure into a classified ImageEnhanceError. */
async function httpCall<T>(phase: Phase, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw classifyHttpError(error, phase);
  }
}

function classifyHttpError(error: unknown, phase: Phase): ImageEnhanceError {
  if (!axios.isAxiosError(error)) {
    const detail = error instanceof Error ? error.message : String(error);
    return new ImageEnhanceError(`${phase} failed: ${detail}`, true);
  }
  const response = error.response;
  if (!response) {
    // No HTTP response at all — a timeout, DNS failure, reset connection.
    const timedOut =
      error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    return new ImageEnhanceError(
      timedOut
        ? `${phase} timed out`
        : `${phase} network error (${error.code ?? error.message})`,
      true,
    );
  }
  const hint = phase === 'download' ? undefined : STATUS_HINTS[response.status];
  return new ImageEnhanceError(
    `${phase} HTTP ${response.status}: ${bodyText(response.data)}` +
      (hint ? ` (${hint})` : ''),
    isRetryableStatus(response.status, phase),
  );
}

/**
 * Whether a failed HTTP status can succeed on a later attempt:
 *   • submit   — 408, 429 (too many active tasks; the queue's exponential backoff
 *                is what BFL asks for) and 5xx are transient. Any other 4xx is
 *                the same rejection on every resubmit: 400/422 invalid request,
 *                401/403 key, 402 credits, 404 unknown model endpoint.
 *   • poll     — 401/402/403 are account problems; anything else (a lost or
 *                expired task, 5xx) is cured by resubmitting.
 *   • download — the signed result URL is not BFL's API: any failure there is
 *                cured by a fresh generation.
 */
function isRetryableStatus(status: number, phase: Phase): boolean {
  if (phase === 'download') return true;
  if (status === 401 || status === 402 || status === 403) return false;
  if (phase === 'poll') return true;
  return status === 408 || status === 429 || status >= 500;
}

/** A response body as bounded text for an error message. */
function bodyText(data: unknown): string {
  const text = Buffer.isBuffer(data)
    ? data.toString('utf8')
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString('utf8')
      : typeof data === 'string'
        ? data
        : (JSON.stringify(data) ?? String(data));
  return text.length > MAX_ERROR_BODY_CHARS
    ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…`
    : text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
