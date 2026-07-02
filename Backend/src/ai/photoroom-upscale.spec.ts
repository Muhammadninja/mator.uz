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
  minLongSide: 2000,
  alwaysUpscaleBelow: 1200,
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

describe('shouldUpscale — threshold logic', () => {
  it('960×1280 → upscale (long side 1280 < 2000)', () => {
    expect(shouldUpscale(Math.max(960, 1280), DEFAULT_CFG)).toBe(true);
  });

  // Boundary semantics (resolved against a contradictory spec): the rule
  // "longSide ≥ minLongSide ⇒ skip" wins, so a long side of exactly 2000 SKIPS.
  // This upholds "Images ≥2000px must never call the Upscale API". (The spec's
  // "1500×2000 → Upscale called" example is treated as a typo — long side 2000.)
  it('1500×2000 → NOT upscale (long side 2000 = min boundary, skip)', () => {
    expect(shouldUpscale(Math.max(1500, 2000), DEFAULT_CFG)).toBe(false);
  });

  it('long side 1999 → upscale (just under min)', () => {
    expect(shouldUpscale(1999, DEFAULT_CFG)).toBe(true);
  });

  it('2000×3000 → NOT upscale (long side 3000 ≥ 2000)', () => {
    expect(shouldUpscale(Math.max(2000, 3000), DEFAULT_CFG)).toBe(false);
  });

  it('4000×3000 → NOT upscale (long side 4000 ≥ 2000)', () => {
    expect(shouldUpscale(Math.max(4000, 3000), DEFAULT_CFG)).toBe(false);
  });

  it('disabled config never upscales', () => {
    expect(shouldUpscale(500, { ...DEFAULT_CFG, enabled: false })).toBe(false);
  });
});

describe('resolveUpscaleConfig — env parsing & validation', () => {
  it('uses spec defaults when env is empty', () => {
    expect(resolveUpscaleConfig({})).toEqual({
      enabled: true,
      minLongSide: 2000,
      alwaysUpscaleBelow: 1200,
      mode: 'ai.fast',
    });
  });

  it('AI_UPSCALE_ENABLED=false disables', () => {
    expect(resolveUpscaleConfig({ AI_UPSCALE_ENABLED: 'false' }).enabled).toBe(false);
  });

  it('parses overridden numeric thresholds', () => {
    const cfg = resolveUpscaleConfig({
      AI_UPSCALE_MIN_LONG_SIDE: '2400',
      AI_UPSCALE_ALWAYS_UPSCALE_BELOW: '1000',
    });
    expect(cfg.minLongSide).toBe(2400);
    expect(cfg.alwaysUpscaleBelow).toBe(1000);
  });

  it('invalid numeric values fall back to default with a warning', () => {
    const warnings: string[] = [];
    const cfg = resolveUpscaleConfig({ AI_UPSCALE_MIN_LONG_SIDE: 'abc' }, (m) => warnings.push(m));
    expect(cfg.minLongSide).toBe(2000);
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
  it('960×1280 → Upscale API IS called', async () => {
    const { svc, calls } = makeService();
    const img = await makeImage(960, 1280);
    const out = await svc.maybeUpscale(img);
    expect(calls).toEqual(['upscale (ai.fast)']);
    expect(out.toString()).toBe('UPSCALED'); // returns the upscaled buffer
  });

  it('1500×1999 → Upscale API IS called (mid band, under 2000)', async () => {
    const { svc, calls } = makeService();
    const img = await makeImage(1500, 1999);
    await svc.maybeUpscale(img);
    expect(calls).toEqual(['upscale (ai.fast)']);
  });

  it('2000×3000 → Upscale API is NOT called', async () => {
    const { svc, calls } = makeService();
    const img = await makeImage(2000, 3000);
    const out = await svc.maybeUpscale(img);
    expect(calls).toEqual([]); // never touches the API
    expect(out).toBe(img); // original returned unchanged
  });

  it('4000×3000 → Upscale API is NOT called', async () => {
    const { svc, calls } = makeService();
    const img = await makeImage(4000, 3000);
    const out = await svc.maybeUpscale(img);
    expect(calls).toEqual([]);
    expect(out).toBe(img);
  });

  it('Upscale failure falls back to the ORIGINAL image (no throw)', async () => {
    const { svc, calls, setUpscaleResult } = makeService();
    // callPhotoroom for a non-required step returns null on failure.
    setUpscaleResult(null);
    const img = await makeImage(960, 1280);

    const out = await svc.maybeUpscale(img);

    expect(calls).toEqual(['upscale (ai.fast)']); // it was attempted…
    expect(out).toBe(img); // …but the original is returned, upload proceeds
  });
});
