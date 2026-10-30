import { Injectable } from '@nestjs/common';
import axios, { type AxiosResponse } from 'axios';

// Black Forest Labs FLUX.2 Pro — the production model in the FLUX.2 family.
// The API is asynchronous: POST the edit request, receive a polling_url, then GET
// that url until the job is Ready (or errors), and finally download the produced
// image from the signed result URL. Endpoint and parameter names below are taken
// from the official BFL API schema (Flux2Inputs) — not assumed.
const FLUX_ENDPOINT = 'https://api.bfl.ai/v1/flux-2-pro';

// Target canvas. FLUX.2 accepts explicit width/height (nullable ints, min 64) to
// fix the output resolution; there is no aspect_ratio field, so this is how the
// exact 1000×1000 output is requested. The prompt handles composition inside it
// (centered, ~85–90% fill, even margins) — width/height only set the canvas.
const OUTPUT_WIDTH = 1000;
const OUTPUT_HEIGHT = 1000;

// The single prompt used for every request: a better PHOTO of the same part on a
// pure white 1000×1000 canvas. FLUX improves exposure, lighting, white balance,
// color accuracy and noise and replaces the background and surroundings. The only
// change allowed to the part itself is cosmetic cleaning (rust, corrosion, dirt,
// dust, grease, oil stains, minor superficial scratches and scuffs); an already
// clean surface stays unchanged. Everything else is the original object as
// photographed: geometry, shape, proportions, materials, colors, texture,
// components, holes, threads, connectors, mounting points, cracks, bends,
// deformations and other structural damage, plus every visible logo, number, text
// and marking; nothing is added, removed or invented. Cleaning is stated as the
// ceiling instead of listing "do not repair / restore / rebuild" verbs: FLUX.2 has
// no negative prompt, BFL's prompting guide says it weighs earlier words more and
// that naming an unwanted feature tends to draw it in, and "restore…" wording
// already invited FLUX to rebuild surfaces. Deliberately no "sharp…" wording: the
// model reads it as license to reconstruct detail, text included. FLUX.2 [pro]
// applies prompt upsampling by default, so the model does not see this text
// exactly as written; this request does not set disable_pup.
const FLUX_PROMPT =
  'Create a catalog photograph of the exact spare part in the input image: improve ' +
  'exposure, lighting, white balance and color accuracy, reduce noise, and replace the ' +
  'background and surroundings with pure white (#FFFFFF). Output exactly 1000×1000 pixels, ' +
  'the part centered, filling about 85–90% of the canvas, proportions unchanged.\n\n' +
  'Cosmetic cleaning is the maximum change allowed to the part: remove rust, corrosion, dirt, ' +
  'dust, grease, oil stains and minor superficial scratches and scuffs. An already clean ' +
  'surface stays unchanged.\n\n' +
  'Keep the part exactly as photographed: geometry, shape, proportions, materials, colors, ' +
  'texture, components, holes, threads, connectors and mounting points, including cracks, ' +
  'bends, deformations and structural damage. Show every visible logo, number, text, marking, ' +
  'fastener and detail, with nothing added, removed or invented.';

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
  403: 'BFL API key may not use this model, check BFL_API_KEY',
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
 * backed by Black Forest Labs FLUX.2 Pro.
 *
 * Pipeline (nothing else — no local resize, compositing, or post-processing):
 *   1. receive the uploaded image buffer,
 *   2. submit it to FLUX.2 Pro (base64) with the catalog-photo prompt,
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
   * background via FLUX.2 Pro, returning the PNG it produces with no further
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
        this.redact(`ImageEnhanceService: FLUX.2 Pro edit failed — ${detail}`),
        // Anything unclassified gets the queue's bounded retry.
        error instanceof ImageEnhanceError ? error.retryable : true,
      );
    }
  }

  /** Submit the edit request; returns the polling URL for this job. */
  private async submit(imageBuffer: Buffer): Promise<string> {
    const response = await httpCall('submit', () =>
      axios.post<SubmitResponse>(
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
        headers: { 'x-key': this.apiKey, Accept: 'application/json' },
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
    return text.replaceAll(this.apiKey, '[REDACTED]');
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
