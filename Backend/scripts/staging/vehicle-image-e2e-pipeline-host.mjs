#!/usr/bin/env node
/** Test-only host: contract-2 pipeline plus a Cloudinary-compatible local stub. */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const source = path.resolve(process.env.VEHICLE_IMAGE_PIPELINE_SOURCE || '');
const dataDir = path.resolve(process.env.VEHICLE_IMAGE_E2E_PIPELINE_DATA || '');
const port = Number(process.env.VEHICLE_IMAGE_E2E_PIPELINE_PORT || 38048);
const proxyPort = Number(process.env.VEHICLE_IMAGE_E2E_PROXY_PORT || 38049);
const registrySha256 = process.env.VEHICLE_IMAGE_REGISTRY_SHA256 || '';
const requestToken = process.env.VEHICLE_IMAGE_REQUEST_TOKEN || '';
const adminToken = process.env.VEHICLE_IMAGE_ADMIN_TOKEN || '';
if (!source || !dataDir || !/^[0-9a-f]{64}$/.test(registrySha256) || requestToken.length < 32 || adminToken.length < 32)
  throw new Error('isolated pipeline source, data directory, registry SHA and service tokens are required');

const at = (relative) => pathToFileURL(path.join(source, relative)).href;
const [{ createVehicleImagePipeline }, { createRepositoryArtworkProvider }, { createCloudinaryAssetStore }, { loadRegistryFile }] = await Promise.all([
  import(at('services/vehicle-image-pipeline.mjs')),
  import(at('services/vehicle-image-acquisition.mjs')),
  import(at('services/vehicle-image-cloudinary-store.mjs')),
  import(at('services/vehicle-image-registry.mjs')),
]);
const registry = loadRegistryFile(path.join(source, 'services/vehicle-image-catalog.json'));
if (registry.sha256 !== registrySha256) throw new Error('pipeline source registry does not match the requested backend fingerprint');

let failNextPublication = false;
let failFirstRequest = true;
let requestAttempts = 0;
let failedRequests = 0;
const uploads = [];
const cloudinary = createCloudinaryAssetStore({
  cloudName: 'mator-isolated-e2e',
  apiKey: 'local-test-key',
  apiSecret: 'local-test-secret',
  fetchImpl: async (_url, init) => {
    if (failNextPublication) {
      failNextPublication = false;
      return new Response(JSON.stringify({ error: { message: 'isolated publication failure' } }), { status: 503 });
    }
    const form = init.body;
    const file = form.get('file');
    const bytes = Buffer.from(await file.arrayBuffer());
    const publicId = String(form.get('public_id'));
    const digest = createHash('sha256').update(bytes).digest('hex');
    uploads.push({ publicId, digest, bytes: bytes.length, contentType: file.type });
    return new Response(JSON.stringify({
      secure_url: `https://res.cloudinary.com/mator-isolated-e2e/image/upload/v1/${publicId}.webp`,
      public_id: publicId,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
const pipeline = createVehicleImagePipeline({
  dataDir,
  adminToken,
  requestToken,
  generationEnabled: false,
  publicationEnabled: true,
  assetStore: cloudinary,
  artworkProvider: createRepositoryArtworkProvider({ rootDir: source }),
  autoRun: true,
  expectedRegistrySha256: registrySha256,
});
await pipeline.initialize();
const upstream = pipeline.server();
await new Promise((resolve, reject) => {
  upstream.once('error', reject);
  upstream.listen(port, '127.0.0.1', resolve);
});

const proxy = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/__test/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ requestAttempts, failedRequests, cloudinaryUploads: uploads }));
  }
  if (url.pathname === '/__test/fail-next-publication' && req.method === 'POST') {
    failNextPublication = true;
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/internal/v1/vehicle-images/requests' && req.method === 'POST') {
    requestAttempts += 1;
    if (failFirstRequest) {
      failFirstRequest = false;
      failedRequests += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'isolated one-time dispatch failure' }));
    }
  }
  const forward = http.request({
    hostname: '127.0.0.1', port, method: req.method, path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  forward.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(forward);
});
await new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(proxyPort, '127.0.0.1', resolve);
});
console.log(JSON.stringify({ status: 'ready', contract: 2, registrySha256, generation: false, publication: true, cloudinary: 'isolated stub' }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => proxy.close(() => upstream.close(() => process.exit(0))));
