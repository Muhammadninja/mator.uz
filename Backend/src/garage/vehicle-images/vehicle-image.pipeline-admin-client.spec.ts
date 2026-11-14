import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VehicleImagePipelineAdminClient } from './vehicle-image.pipeline-admin-client';

const ADMIN = 'pipeline-admin-token-for-tests-000000000001';
const ID = '11111111-2222-4333-8444-555555555555';

function client(env: Record<string, string> = {}) {
  const c = new VehicleImagePipelineAdminClient(new ConfigService({
    VEHICLE_IMAGE_PIPELINE_URL: 'https://pipeline.test/vi',
    VEHICLE_IMAGE_ADMIN_TOKEN: ADMIN,
    ...env,
  }));
  const fetchImpl = jest.fn();
  c.fetchImpl = fetchImpl;
  return { c, fetchImpl };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('VehicleImagePipelineAdminClient', () => {
  it('is unavailable without the admin token and calls nothing', async () => {
    const { c, fetchImpl } = client({ VEHICLE_IMAGE_ADMIN_TOKEN: '' });
    expect(c.available).toBe(false);
    await expect(c.reviewQueue()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the admin token server-side and the actor in the body', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValue(json(200, { id: ID, status: 'approved' }));
    await c.approve(ID, { actor: { id: 'adm', email: 'a@b.c', name: 'A' } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://pipeline.test/vi/admin/candidates/${ID}/approve`);
    expect(init.headers.authorization).toBe(`Bearer ${ADMIN}`);
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toEqual({ actor: { id: 'adm', email: 'a@b.c', name: 'A' } });
  });

  it('never builds a URL from anything but a pipeline id', async () => {
    const { c, fetchImpl } = client();
    for (const bad of ['../metrics', `${ID}/../../x`, 'abc', `${ID}?x=1`, '']) {
      await expect(c.history(bad)).rejects.toBeInstanceOf(HttpException);
      await expect(c.approve(bad, { actor: { id: 'a', email: 'b', name: 'c' } })).rejects.toBeInstanceOf(HttpException);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the pipeline refusal through with its status, and hides transport details', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValueOnce(json(409, { error: 'identity confirmation is required for an unverified identity' }));
    await expect(c.approve(ID, { actor: { id: 'a', email: 'b', name: 'c' } })).rejects.toMatchObject({
      status: 409, message: 'identity confirmation is required for an unverified identity',
    });
    fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }));
    const err = await c.metrics().catch((e: HttpException) => e);
    expect((err as HttpException).getStatus()).toBe(502);
    expect((err as HttpException).message).toContain('network:ECONNREFUSED');
    expect((err as HttpException).message).not.toContain(ADMIN);
  });

  it('serves a preview only as an image', async () => {
    const { c, fetchImpl } = client();
    fetchImpl.mockResolvedValueOnce(new Response(Buffer.from('<svg/>'), { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
    await expect(c.preview(ID)).rejects.toMatchObject({ status: 502 });
    fetchImpl.mockResolvedValueOnce(new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp' } }));
    await expect(c.preview(ID)).resolves.toEqual({ bytes: Buffer.from([1, 2, 3]), contentType: 'image/webp' });
  });
});
