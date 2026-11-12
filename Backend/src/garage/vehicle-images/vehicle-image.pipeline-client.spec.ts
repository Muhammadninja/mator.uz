import { ConfigService } from '@nestjs/config';
import {
  canonicalIdentityKey,
  type CanonicalVehicleIdentity,
} from './vehicle-image.identity';
import {
  PipelineCallError,
  VehicleImagePipelineClient,
} from './vehicle-image.pipeline-client';

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
      asset: null,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://pipeline.test/vehicle-images/internal/v1/vehicle-images/requests',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
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
