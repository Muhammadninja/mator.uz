import { VehicleImageStatus } from '@prisma/client';
import { presentVehicleImage, stateFromPipeline } from './vehicle-image.state';
import type { PipelineStatusResult } from './vehicle-image.pipeline-client';

const NOW = new Date('2026-11-12T10:00:00Z');
const KEY = 'c'.repeat(64);
const result = (over: Partial<PipelineStatusResult>): PipelineStatusResult => ({
  identityKey: KEY,
  status: 'queued',
  requestId: 'req-1',
  asset: null,
  ...over,
});

describe('stateFromPipeline', () => {
  it.each(['queued', 'running', 'awaiting_approval', 'pending'] as const)(
    '%s is pending, no URL',
    (status) => {
      expect(stateFromPipeline(result({ status }), NOW)).toMatchObject({
        status: VehicleImageStatus.PENDING,
        reason: null,
        imageUrl: null,
        imageVersion: null,
      });
    },
  );

  it('approved with a published https URL exposes url and version', () => {
    const s = stateFromPipeline(
      result({
        status: 'approved',
        asset: { url: 'https://res.cloudinary.com/x/v2.webp', version: 2 },
      }),
      NOW,
    );
    expect(s).toMatchObject({
      status: VehicleImageStatus.APPROVED,
      imageUrl: 'https://res.cloudinary.com/x/v2.webp',
      imageVersion: 2,
    });
    expect(s.nextSyncAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('approved but unpublished (pipeline-local path) stays pending without a URL', () => {
    expect(
      stateFromPipeline(
        result({
          status: 'approved',
          asset: { url: `/published/${KEY}/v1`, version: 1 },
        }),
        NOW,
      ),
    ).toMatchObject({
      status: VehicleImageStatus.PENDING,
      reason: 'awaiting_publication',
      imageUrl: null,
    });
  });

  it('approved bundled catalog key is approved without a publication URL', () => {
    expect(stateFromPipeline(result({
      status: 'approved',
      asset: { url: null, version: 1, catalogAssetKey: 'cobalt-gen2' },
    }), NOW)).toMatchObject({
      status: VehicleImageStatus.APPROVED,
      imageUrl: null,
      imageVersion: 1,
      catalogAssetKey: 'cobalt-gen2',
    });
  });

  it('needs_review remains unavailable and does not expose an asset', () => {
    expect(stateFromPipeline(result({ status: 'needs_review' }), NOW)).toMatchObject({
      status: VehicleImageStatus.UNAVAILABLE,
      reason: 'identity_review_required',
      imageUrl: null,
    });
  });

  it('failed and rejected are unavailable (never re-requested)', () => {
    expect(stateFromPipeline(result({ status: 'failed' }), NOW)).toMatchObject({
      status: VehicleImageStatus.UNAVAILABLE,
      reason: 'generation_failed',
    });
    expect(
      stateFromPipeline(result({ status: 'rejected' }), NOW),
    ).toMatchObject({
      status: VehicleImageStatus.UNAVAILABLE,
      reason: 'rejected',
    });
  });

  it('not_found keeps an already published image, otherwise request_missing', () => {
    const prev = {
      status: VehicleImageStatus.APPROVED,
      imageUrl: 'https://cdn.test/a.webp',
      imageVersion: 3,
    };
    expect(
      stateFromPipeline(
        result({ status: 'not_found', requestId: null }),
        NOW,
        prev,
      ),
    ).toMatchObject({
      status: VehicleImageStatus.APPROVED,
      imageUrl: 'https://cdn.test/a.webp',
      imageVersion: 3,
    });
    expect(
      stateFromPipeline(result({ status: 'not_found', requestId: null }), NOW),
    ).toMatchObject({
      status: VehicleImageStatus.UNAVAILABLE,
      reason: 'request_missing',
      nextSyncAt: null,
    });
  });
});

describe('presentVehicleImage', () => {
  const identity = (over = {}) => ({
    status: VehicleImageStatus.PENDING,
    reason: null,
    imageUrl: null,
    imageVersion: null,
    ...over,
  });

  it('legacy / disabled vehicles: unavailable, not_requested', () => {
    expect(presentVehicleImage({})).toEqual({
      status: 'unavailable',
      url: null,
      version: null,
      reason: 'not_requested',
    });
  });

  it('ambiguous identity: unavailable, needs_review', () => {
    expect(
      presentVehicleImage({
        imageReviewReason: 'duplicate_model_name',
        imageIdentity: null,
      }),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'needs_review',
    });
  });

  it('maps stored states', () => {
    expect(presentVehicleImage({ imageIdentity: identity() })).toEqual({
      status: 'pending',
      url: null,
      version: null,
      reason: null,
    });
    expect(
      presentVehicleImage({
        imageIdentity: identity({
          status: VehicleImageStatus.APPROVED,
          imageUrl: 'https://cdn.test/a.webp',
          imageVersion: 1,
          identity: { modelId: 'cobalt', marketRegion: 'UZ' },
        }),
      }),
    ).toEqual({
      status: 'approved',
      url: 'https://cdn.test/a.webp',
      version: 1,
      reason: null,
    });
    expect(
      presentVehicleImage({
        imageIdentity: identity({
          status: VehicleImageStatus.UNAVAILABLE,
          reason: 'generation_failed',
        }),
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'generation_failed' });
    expect(
      presentVehicleImage({
        imageIdentity: identity({
          status: VehicleImageStatus.UNAVAILABLE,
          reason: 'dispatch_failed',
        }),
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'request_failed' });
    expect(
      presentVehicleImage({
        imageIdentity: identity({
          status: VehicleImageStatus.UNAVAILABLE,
          reason: 'not_requested',
        }),
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'not_requested' });
  });

  it('never shows a publication of a market-less (legacy) identity, e.g. a US-market Spark', () => {
    const legacies = [
      undefined,
      null,
      { modelId: 'spark' },
      { marketRegion: 1 },
    ];
    for (const legacy of legacies) {
      expect(
        presentVehicleImage({
          imageIdentity: identity({
            status: VehicleImageStatus.APPROVED,
            imageUrl: 'https://res.cloudinary.test/spark-us.webp',
            imageVersion: 1,
            identity: legacy,
          }),
        }),
      ).toEqual({
        status: 'unavailable',
        url: null,
        version: null,
        // Not needs_review: the app may still show its own owner-approved image.
        reason: 'not_requested',
      });
    }
  });

  it('never shows a registry image whose approval was withdrawn or never given', () => {
    for (const key of ['spark-m300', 'nexia-n150', 'tracker-gen3', 'made-up']) {
      expect(
        presentVehicleImage({
          imageIdentity: identity({
            status: VehicleImageStatus.APPROVED,
            catalogAssetKey: key,
            imageVersion: 1,
          }),
        }),
      ).toEqual({
        status: 'unavailable',
        url: null,
        version: null,
        reason: 'needs_review',
      });
    }
  });

  it('returns the approved catalog key for the frontend bundle resolver', () => {
    expect(presentVehicleImage({ imageIdentity: identity({
      status: VehicleImageStatus.APPROVED,
      catalogAssetKey: 'cobalt-gen2',
      imageVersion: 1,
    }) })).toEqual({
      status: 'approved', url: null, version: 1,
      catalog_asset_key: 'cobalt-gen2', reason: null,
    });
  });

  it('never exposes a non-https URL even if one was stored', () => {
    expect(
      presentVehicleImage({
        imageIdentity: identity({
          status: VehicleImageStatus.APPROVED,
          imageUrl: 'http://cdn.test/a.webp',
          imageVersion: 1,
        }),
      }).url,
    ).toBeNull();
  });
});
