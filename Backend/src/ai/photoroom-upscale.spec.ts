// Tests for the conditional AI-Upscale pre-stage in PhotoroomService.
//
// Two layers:
//  1. shouldUpscale / resolveUpscaleConfig — the pure decision + config logic.
//  2. maybeUpscale — the integration point: reads Sharp metadata, decides, and
//     (on decision) calls the Photoroom upscale endpoint, falling back to the
//     original image on failure. The network call (callPhotoroom) is stubbed so
//     no HTTP happens; we assert only whether it was invoked and what comes back.

import sharp from 'sharp';
import {
  PhotoroomService,
  resolveUpscaleConfig,
  shouldUpscale,
  type UpscaleConfig,
} from './photoroom.service';

const DEFAULT_CFG: UpscaleConfig = {
  enabled: true,
  maxPixels: 1_000_000,
  mode: 'ai.fast',
};

// Build a real JPEG of the given dimensions so Sharp metadata reads true values.
async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } },
  })
    .jpeg()
    .toBuffer();
}

// A PhotoroomService instance whose network layer is stubbed. `callPhotoroom`
// (private) is replaced so upscale/removeBackground never hit HTTP.
function makeService(cfg: Partial<UpscaleConfig> = {}): {
  svc: { maybeUpscale: (b: Buffer) => Promise<Buffer> };
  calls: string[];
  setUpscaleResult: (r: Buffer | null | (() => never)) => void;
} {
  const calls: string[] = [];
  let upscaleResult: Buffer | null | (() => never) = Buffer.from('UPSCALED');

  const svc = Object.create(PhotoroomService.prototype) as Record<string, unknown>;
  Object.assign(svc, {
    apiKey: 'test-key',
    upscaleConfig: { ...DEFAULT_CFG, ...cfg },
    // Stub the single network chokepoint used by upscaleImage.
    callPhotoroom: async (
      _buildForm: unknown,
      label: string,
      _opts: unknown,
    ): Promise<Buffer | null> => {
      calls.push(label);
      if (typeof upscaleResult === 'function') return upscaleResult(); // throws
      return upscaleResult;
    },
  });

  return {
    svc: svc as unknown as { maybeUpscale: (b: Buffer) => Promise<Buffer> },
    calls,
    setUpscaleResult: (r) => {
      upscaleResult = r;
    },
  };
}

describe('shouldUpscale — pixel-limit logic (≤ 1,000,000 px)', () => {
  it('960×1280 = 1,228,800 px → NOT upscale (over 1,000,000 limit)', () => {
    expect(shouldUpscale(960 * 1280, DEFAULT_CFG)).toBe(false);
  });

  it('800×1000 = 800,000 px → upscale (under the limit)', () => {
    expect(shouldUpscale(800 * 1000, DEFAULT_CFG)).toBe(true);
  });

  // Boundary: exactly 1,000,000 px is at the limit and MUST upscale
  // ("1,000,000 pixels or fewer" is included).
  it('1000×1000 = 1,000,000 px → upscale (at the limit, inclusive)', () => {
    expect(shouldUpscale(1000 * 1000, DEFAULT_CFG)).toBe(true);
  });

  it('1,000,001 px → NOT upscale (just over the limit)', () => {
    expect(shouldUpscale(1_000_001, DEFAULT_CFG)).toBe(false);
  });

  it('2000×3000 = 6,000,000 px → NOT upscale (well over the limit)', () => {
    expect(shouldUpscale(2000 * 3000, DEFAULT_CFG)).toBe(false);
  });

  it('disabled config never upscales', () => {
    expect(shouldUpscale(500 * 500, { ...DEFAULT_CFG, enabled: false })).toBe(false);
  });
});

describe('resolveUpscaleConfig — env parsing & validation', () => {
  it('uses spec defaults when env is empty', () => {
    expect(resolveUpscaleConfig({})).toEqual({
      enabled: true,
      maxPixels: 1_000_000,
      mode: 'ai.fast',
    });
  });

  it('AI_UPSCALE_ENABLED=false disables', () => {
    expect(resolveUpscaleConfig({ AI_UPSCALE_ENABLED: 'false' }).enabled).toBe(false);
  });

  it('parses an overridden pixel limit', () => {
    const cfg = resolveUpscaleConfig({ AI_UPSCALE_MAX_PIXELS: '2000000' });
    expect(cfg.maxPixels).toBe(2_000_000);
  });

  it('invalid numeric values fall back to default with a warning', () => {
    const warnings: string[] = [];
    const cfg = resolveUpscaleConfig({ AI_UPSCALE_MAX_PIXELS: 'abc' }, (m) => warnings.push(m));
    expect(cfg.maxPixels).toBe(1_000_000);
    expect(warnings).toHaveLength(1);
  });

  it('accepts ai.slow mode', () => {
    expect(resolveUpscaleConfig({ AI_UPSCALE_MODE: 'ai.slow' }).mode).toBe('ai.slow');
  });

  it('invalid mode falls back to ai.fast with a warning', () => {
    const warnings: string[] = [];
    const cfg = resolveUpscaleConfig({ AI_UPSCALE_MODE: 'ai.turbo' }, (m) => warnings.push(m));
    expect(cfg.mode).toBe('ai.fast');
    expect(warnings).toHaveLength(1);
  });
});

describe('maybeUpscale — integration (metadata → decide → call/fallback)', () => {
  it('800×1000 = 800,000 px → Upscale API IS called (under the limit)', async () => {
    const { svc, calls } = makeService();
    const img = await makeImage(800, 1000);
    const out = await svc.maybeUpscale(img);
    expect(calls).toEqual(['upscale (ai.fast)']);
    expect(out.toString()).toBe('UPSCALED'); // returns the upscaled buffer
  });

  it('1000×1000 = 1,000,000 px → Upscale API IS called (at the limit)', async () => {
    const { svc, calls } = makeService();
    const img = await makeImage(1000, 1000);
    await svc.maybeUpscale(img);
    expect(calls).toEqual(['upscale (ai.fast)']);
  });

  it('960×1280 = 1,228,800 px → Upscale API is NOT called (over the limit)', async () => {
    const { svc, calls } = makeService();
    const img = await makeImage(960, 1280);
    const out = await svc.maybeUpscale(img);
    expect(calls).toEqual([]); // never touches the API
    expect(out).toBe(img); // original returned unchanged, pipeline continues
  });

  it('2000×3000 = 6,000,000 px → Upscale API is NOT called', async () => {
    const { svc, calls } = makeService();
    const img = await makeImage(2000, 3000);
    const out = await svc.maybeUpscale(img);
    expect(calls).toEqual([]);
    expect(out).toBe(img);
  });

  it('Upscale failure falls back to the ORIGINAL image (no throw)', async () => {
    const { svc, calls, setUpscaleResult } = makeService();
    // callPhotoroom for a non-required step returns null on failure.
    setUpscaleResult(null);
    const img = await makeImage(800, 1000);

    const out = await svc.maybeUpscale(img);

    expect(calls).toEqual(['upscale (ai.fast)']); // it was attempted…
    expect(out).toBe(img); // …but the original is returned, upload proceeds
  });
});
