import { ConfigService } from '@nestjs/config';
import {
  canonicalIdentityKey,
  type CanonicalVehicleIdentity,
} from './vehicle-image.identity';
import {
  networkErrorCode,
  PipelineCallError,
  VehicleImagePipelineClient,
} from './vehicle-image.pipeline-client';
import { VEHICLE_IMAGE_REGISTRY_SHA256 } from './vehicle-image.catalog';

const TOKEN = 'server-to-server-request-token-for-tests-0001';
const IDENTITY: CanonicalVehicleIdentity = {
  makeId: 'byd',
  modelId: 'byd-han',
  modelYear: 2024,
  generationId: null,
  faceliftId: null,
  bodyType: null,
  trimId: null,
};
const KEY = canonicalIdentityKey(IDENTITY);
const DISPLAY = { manufacturer: 'BYD', model: 'Han' };

function client(env: Record<string, string> = {}) {
  const config = new ConfigService({
    VEHICLE_IMAGES_ENABLED: 'true',
    VEHICLE_IMAGE_PIPELINE_URL: 'https://pipeline.test/vehicle-images',
    VEHICLE_IMAGE_REQUEST_TOKEN: TOKEN,
    VEHICLE_IMAGE_MARKET_REGION: 'UZ',
    ...env,
  });
  const c = new VehicleImagePipelineClient(config);
  const fetchImpl = jest.fn();
  c.fetchImpl = fetchImpl;
  return { c, fetchImpl };
}

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });

const statusBody = (over = {}) => ({
  identityKey: KEY,
  identity: IDENTITY,
  status: 'queued',
  requestId: 'r-1',
  jobId: 'j-1',
  asset: null,
  duplicate: false,
  reused: false,
  deduplicated: false,
  subjectKey: `identity:${KEY}`,
  registry: { version: 1, sha256: VEHICLE_IMAGE_REGISTRY_SHA256 },
  ...over,
});

async function codeOf(
  p: Promise<unknown>,
): Promise<{ code: string; retryable: boolean }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PipelineCallError);
    return {
      code: (err as PipelineCallError).code,
      retryable: (err as PipelineCallError).retryable,
    };
  }
  throw new Error('expected a PipelineCallError');
}

describe('VehicleImagePipelineClient', () => {
  it('POSTs {identity, vehicle} to the internal requests route with the service bearer token', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValue(reply(202, statusBody()));
    const res = await c.request(IDENTITY, DISPLAY);
    expect(res).toEqual({
      identityKey: KEY,
      status: 'queued',
      requestId: 'r-1',
      subjectKey: `identity:${KEY}`,
      asset: null,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://pipeline.test/vehicle-images/internal/v1/vehicle-images/requests',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['x-mator-vehicle-image-contract']).toBe('2');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toEqual({
      identity: IDENTITY,
      vehicle: DISPLAY,
    });
  });

  it('resolve sends only {identity} and accepts approved assets', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValue(
      reply(
        200,
        statusBody({
          status: 'approved',
          asset: { url: 'https://cdn.test/a.webp', version: 2 },
        }),
      ),
    );
    const res = await c.resolve(IDENTITY);
    expect(res.asset).toEqual({ url: 'https://cdn.test/a.webp', version: 2 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      identity: IDENTITY,
    });
    expect(fetchImpl.mock.calls[0][0]).toMatch(
      /\/internal\/v1\/vehicle-images\/resolve$/,
    );
  });

  it('accepts local approved catalog keys and review-required statuses', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValueOnce(reply(200, statusBody({
      status: 'approved', asset: { url: null, version: 1, catalogAssetKey: 'cobalt-gen2' },
    })));
    await expect(c.resolve(IDENTITY)).resolves.toMatchObject({
      status: 'approved', asset: { url: null, catalogAssetKey: 'cobalt-gen2' },
    });
    fetchImpl.mockResolvedValueOnce(reply(200, statusBody({ status: 'needs_review' })));
    await expect(c.resolve(IDENTITY)).resolves.toMatchObject({ status: 'needs_review' });
  });

  it('classifies transport and HTTP failures', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockRejectedValueOnce(
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
    );
    expect(await codeOf(c.request(IDENTITY, DISPLAY))).toEqual({
      code: 'timeout',
      retryable: true,
    });
    fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await codeOf(c.request(IDENTITY, DISPLAY))).toEqual({
      code: 'network',
      retryable: true,
    });
    fetchImpl.mockResolvedValueOnce(
      reply(403, { error: 'service authorization required' }),
    );
    expect(await codeOf(c.request(IDENTITY, DISPLAY))).toEqual({
      code: 'http_403',
      retryable: true,
    });
    fetchImpl.mockResolvedValueOnce(reply(503, 'Bad Gateway'));
    expect(await codeOf(c.request(IDENTITY, DISPLAY))).toEqual({
      code: 'http_503',
      retryable: true,
    });
    fetchImpl.mockResolvedValueOnce(
      reply(400, { error: 'canonical identity contains unsupported fields' }),
    );
    expect(await codeOf(c.request(IDENTITY, DISPLAY))).toEqual({
      code: 'pipeline_rejected_request',
      retryable: false,
    });
  });

  it('refuses a response for another identity or outside the contract', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValueOnce(
      reply(202, statusBody({ identityKey: 'f'.repeat(64) })),
    );
    expect(await codeOf(c.request(IDENTITY, DISPLAY))).toEqual({
      code: 'identity_key_mismatch',
      retryable: false,
    });
    fetchImpl.mockResolvedValueOnce(
      reply(200, statusBody({ status: 'exploded' })),
    );
    expect(await codeOf(c.resolve(IDENTITY))).toEqual({
      code: 'contract_mismatch',
      retryable: false,
    });
    fetchImpl.mockResolvedValueOnce(
      reply(200, statusBody({ status: 'approved', asset: null })),
    );
    expect(await codeOf(c.resolve(IDENTITY))).toEqual({
      code: 'contract_mismatch',
      retryable: false,
    });
    fetchImpl.mockResolvedValueOnce(reply(200, '<html>'));
    expect(await codeOf(c.resolve(IDENTITY))).toEqual({
      code: 'contract_mismatch',
      retryable: false,
    });
  });

  it('does not call out while disabled', async () => {
    const { c, fetchImpl } = client({ VEHICLE_IMAGES_ENABLED: 'false' });
    expect(c.enabled).toBe(false);
    expect(await codeOf(c.request(IDENTITY, DISPLAY))).toEqual({
      code: 'integration_disabled',
      retryable: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the token in an error', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockRejectedValueOnce(new Error(`boom ${TOKEN}`));
    try {
      await c.request(IDENTITY, DISPLAY);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(TOKEN);
    }
  });
});

describe('VehicleImagePipelineClient: contract 2', () => {
  it('refuses an answer from an older pipeline or another registry, retryably, and applies nothing', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValueOnce(reply(200, statusBody({ registry: undefined })));
    expect(await codeOf(c.resolve(IDENTITY))).toEqual({ code: 'pipeline_outdated', retryable: true });
    fetchImpl.mockResolvedValueOnce(reply(200, statusBody({ registry: { version: 1, sha256: 'a'.repeat(64) } })));
    expect(await codeOf(c.resolve(IDENTITY))).toEqual({ code: 'registry_mismatch', retryable: true });
  });

  it('accepts awaiting_source and the subject key', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValueOnce(reply(202, statusBody({ status: 'awaiting_source', subjectKey: 'catalog:nexia-n150' })));
    await expect(c.request(IDENTITY, DISPLAY)).resolves.toMatchObject({
      status: 'awaiting_source',
      subjectKey: 'catalog:nexia-n150',
    });
  });

  it('never accepts a published image for an unverified identity without a person confirming it', async () => {
    const unverified: CanonicalVehicleIdentity = { ...IDENTITY, identityStatus: 'unverified' };
    const key = canonicalIdentityKey(unverified);
    const { c, fetchImpl } = client();
    const approved = (asset: Record<string, unknown>) =>
      reply(200, statusBody({ identityKey: key, identity: unverified, status: 'approved', asset }));
    fetchImpl.mockResolvedValueOnce(approved({ url: 'https://cdn.test/a.webp', version: 1 }));
    expect(await codeOf(c.resolve(unverified))).toEqual({ code: 'identity_unconfirmed', retryable: false });
    fetchImpl.mockResolvedValueOnce(approved({ url: 'https://cdn.test/a.webp', version: 1, identityConfirmed: false }));
    expect(await codeOf(c.resolve(unverified))).toEqual({ code: 'identity_unconfirmed', retryable: false });
    fetchImpl.mockResolvedValueOnce(approved({ url: 'https://cdn.test/a.webp', version: 1, identityConfirmed: true }));
    await expect(c.resolve(unverified)).resolves.toMatchObject({
      status: 'approved',
      asset: { url: 'https://cdn.test/a.webp', identityConfirmed: true },
    });
  });

  it('names the transport failure precisely without a host, URL or message', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8047'), { code: 'ECONNREFUSED' }),
    });
    expect(networkErrorCode(refused)).toBe('network:ECONNREFUSED');
    expect(networkErrorCode(new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND images.example'), { code: 'ENOTFOUND' }),
    }))).toBe('network:ENOTFOUND');
    expect(networkErrorCode(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })))
      .toBe('network:redirect');
    expect(networkErrorCode(new TypeError('fetch failed'))).toBe('network');
    expect(networkErrorCode({ code: 'bad code with spaces' })).toBe('network');
    const { c, fetchImpl } = client();
    fetchImpl.mockRejectedValueOnce(refused);
    expect(await codeOf(c.request(IDENTITY, DISPLAY))).toEqual({ code: 'network:ECONNREFUSED', retryable: true });
  });

  it('reads readiness and the registry handshake without authentication, and never throws', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValueOnce(reply(200, {
      status: 'ready', contract: 2, registry: { version: 1, sha256: VEHICLE_IMAGE_REGISTRY_SHA256 },
      capabilities: { artwork: true, generation: false, publication: true },
    }));
    await expect(c.health()).resolves.toEqual({
      ready: true,
      registrySha256: VEHICLE_IMAGE_REGISTRY_SHA256,
      registryMatches: true,
      contract: 2,
      capabilities: { artwork: true, generation: false, publication: true },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://pipeline.test/vehicle-images/health/ready');
    expect(init.headers.authorization).toBeUndefined();
    fetchImpl.mockResolvedValueOnce(reply(200, { status: 'ready' }));
    await expect(c.health()).resolves.toMatchObject({ ready: true, registryMatches: false, registrySha256: null });
    fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }));
    await expect(c.health()).resolves.toMatchObject({ ready: false, error: 'network:ECONNREFUSED' });
    fetchImpl.mockResolvedValueOnce(reply(503, { status: 'starting' }));
    await expect(c.health()).resolves.toMatchObject({ ready: false, error: 'http_503' });
  });
});
