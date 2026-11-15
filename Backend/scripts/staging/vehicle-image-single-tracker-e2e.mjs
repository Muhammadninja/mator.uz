#!/usr/bin/env node
/** One-car end-to-end check through the real local Backend, BullMQ, and pipeline. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const state = path.resolve(process.env.MATOR_INTEGRATION_DIR || '.local/integration');
const envFile = path.join(state, 'environment.json');
const environment = JSON.parse(await fs.readFile(envFile, 'utf8'));
const base = `http://127.0.0.1:${process.env.MATOR_API_PORT || 3300}`;
const pipelinePort = Number(process.env.VEHICLE_IMAGE_E2E_PROXY_PORT || 38049);
const report = { result: 'running', contract: 2, model: 'Chevrolet Tracker (2021)', steps: [] };
let userToken;
let adminToken;
const record = (name, detail) => report.steps.push({ name, detail });

async function call(method, route, body, token, expected = 200) {
  const response = await fetch(`${base}${route}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== expected) {
    const detail = await response.text();
    throw new Error(`${method} ${route}: HTTP ${response.status}; expected ${expected}; ${detail.slice(0, 400)}`);
  }
  return response;
}
async function json(method, route, body, token, expected = 200) {
  return (await call(method, route, body, token, expected)).json();
}
async function pipelineMetrics() {
  return (await fetch(`http://127.0.0.1:${pipelinePort}/__test/metrics`, { signal: AbortSignal.timeout(3000) })).json();
}
async function waitFor(check, description, timeoutMs = 100_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${description}`);
}

const requireFromBackend = createRequire(path.join(state, 'backend/package.json'));
const { PrismaClient, AdminRole } = requireFromBackend('@prisma/client');
const { hashPassword } = requireFromBackend(path.join(state, 'backend/dist/src/auth/password.util.js'));
const prisma = new PrismaClient({ datasources: { db: { url: environment.DATABASE_URL } } });
const phone = `+99890${String(Date.now()).slice(-7)}`;
const adminEmail = `vehicle-image-e2e-${Date.now()}@mator.test`;
const adminPassword = `E2E-${cryptoRandomString(32)}-Pass9`;
let vehicleIds = [];
let actorId;
try {
  // Check the live Backend ↔ pipeline fingerprint before creating the fixture.
  const unauthorized = await call('GET', '/v1/admin/vehicle-images/status', undefined, undefined, 401);
  assert.equal(unauthorized.status, 401, 'admin status must require authenticated administrator credentials');

  const documents = await json('GET', '/v1/legal/documents');
  const versionFor = (type) => {
    const item = documents.documents.find((entry) => entry.type === type);
    assert.ok(item, `seeded legal document ${type} is required`);
    return item.version;
  };
  const otp = await json('POST', '/v1/auth/phone/request-otp', { phone_e164: phone, country_iso2: 'UZ', channel: 'sms', lang: 'en' });
  assert.ok(otp.dev_otp_code, 'the isolated backend must return its development OTP');
  const auth = await json('POST', '/v1/auth/phone/verify-otp', {
    phone_e164: phone, request_id: otp.request_id, otp_code: otp.dev_otp_code,
    legal: {
      terms_version: versionFor('TERMS_OF_USE'),
      privacy_version: versionFor('PRIVACY_POLICY'),
      personal_data_consent_version: versionFor('PERSONAL_DATA_CONSENT'),
    },
  });
  userToken = auth.tokens.access_token;

  const admin = await prisma.appAdmin.create({ data: {
    email: adminEmail,
    passwordHash: await hashPassword(adminPassword),
    name: 'Isolated vehicle image E2E',
    role: AdminRole.MANAGER,
  } });
  actorId = admin.id;
  const session = await json('POST', '/v1/auth/admin/login', { email: adminEmail, password: adminPassword, deviceName: 'isolated-e2e' });
  adminToken = session.accessToken ?? session.tokens?.accessToken ?? session.tokens?.access_token;
  assert.ok(adminToken, 'admin login must issue an authenticated access token');

  const pipelineStatus = await json('GET', '/v1/admin/vehicle-images/status', undefined, adminToken);
  assert.equal(pipelineStatus.pipelineHealth?.ready, true);
  assert.equal(pipelineStatus.registry?.matches, true);
  assert.equal(pipelineStatus.pipelineHealth?.contract, 2);
  record('contract and registry handshake', { contract: 2, registryMatches: true });

  const models = await json('GET', '/v1/reference/models?makeId=chevrolet', undefined, userToken);
  assert.ok(models.items.some((item) => item.id === 'tracker'), 'the seeded Chevrolet Tracker model is required');
  const vehicle = await json('POST', '/v1/garage/vehicles', {
    make_id: 'chevrolet', model_id: 'tracker', year: 2021,
    nickname: 'LOCAL E2E — Chevrolet Tracker', is_primary: false,
  }, userToken, 201);
  vehicleIds.push(vehicle.id);
  const duplicateVehicle = await json('POST', '/v1/garage/vehicles', {
    make_id: 'chevrolet', model_id: 'tracker', year: 2021,
    nickname: 'LOCAL E2E — duplicate Tracker', is_primary: false,
  }, userToken, 201);
  vehicleIds.push(duplicateVehicle.id);
  const stored = await prisma.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { imageIdentityKey: true } });
  const keys = [...new Set(stored.map((item) => item.imageIdentityKey).filter(Boolean))];
  assert.equal(keys.length, 1, 'duplicate Garage vehicles must resolve to one image identity');
  const [key] = keys;
  const outboxCount = await prisma.vehicleImageOutbox.count({ where: { identityKey: key } });
  assert.equal(outboxCount, 1, 'one identity must create one transactional outbox request');
  record('Garage create and deduplication', { vehicleCount: 2, identityCount: 1, outboxCount });

  const retriedOutbox = await waitFor(async () => {
    const row = await prisma.vehicleImageOutbox.findFirst({ where: { identityKey: key }, orderBy: { createdAt: 'desc' } });
    return row?.attempts >= 1 && row?.lastError ? row : null;
  }, 'first BullMQ delivery failure');
  assert.match(retriedOutbox.lastError, /503|network/i);
  const delivered = await waitFor(async () => {
    const row = await prisma.vehicleImageOutbox.findFirst({ where: { identityKey: key }, orderBy: { createdAt: 'desc' } });
    return row?.status === 'DISPATCHED' && row.attempts >= 2 ? row : null;
  }, 'BullMQ retry and successful pipeline dispatch');
  assert.equal(delivered.attempts, 2);
  const acquisition = await waitFor(async () => {
    const queue = await json('GET', '/v1/admin/vehicle-images/queue', undefined, adminToken);
    return queue.find((entry) => entry.identity?.modelId === 'tracker' && entry.identity?.modelYear === 2021 && entry.candidates?.some((candidate) => candidate.status === 'pending'));
  }, 'private Tracker candidate');
  assert.equal(acquisition.verification, 'unverified');
  const candidate = acquisition.candidates.find((entry) => entry.status === 'pending');
  assert.ok(candidate, 'candidate remains pending for review');
  const preview = await call('GET', `/v1/admin/vehicle-images/candidates/${candidate.id}/preview`, undefined, adminToken);
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/webp');
  assert.match(preview.headers.get('cache-control') ?? '', /private/);
  assert.ok(previewBytes.length > 1024, 'private candidate preview must contain processed image data');
  record('BullMQ retry, candidate and private preview', { attempts: delivered.attempts, candidateStatus: candidate.status, previewBytes: previewBytes.length });

  const beforeFail = await pipelineMetrics();
  assert.equal(beforeFail.failedRequests, 1, 'the isolated proxy must have injected exactly one transient failure');
  await fetch(`http://127.0.0.1:${pipelinePort}/__test/fail-next-publication`, { method: 'POST' });
  const confirmation = { confirmed: true, reference: 'Isolated E2E: reviewed Tracker body and year against owner supplied reference' };
  const failedApproval = await call('POST', `/v1/admin/vehicle-images/candidates/${candidate.id}/approve`, { identityConfirmation: confirmation }, adminToken, 503);
  assert.equal(failedApproval.status, 503);
  const stillPending = await json('GET', '/v1/admin/vehicle-images/queue', undefined, adminToken);
  assert.ok(stillPending.some((entry) => entry.requestId === acquisition.requestId && entry.candidates.some((item) => item.id === candidate.id && item.status === 'pending')),
    'failed publication must leave the candidate available for approval retry');
  record('failed publication recovery gate', { firstApprovalStatus: failedApproval.status, candidateStillPending: true });

  const approved = await json('POST', `/v1/admin/vehicle-images/candidates/${candidate.id}/approve`, { identityConfirmation: confirmation }, adminToken);
  assert.equal(approved.candidate?.status, 'approved');
  const garage = await waitFor(async () => {
    const value = await json('GET', `/v1/garage/vehicles/${vehicle.id}/image`, undefined, userToken);
    return value.vehicle_image?.status === 'approved' ? value : null;
  }, 'approved image sync to Garage');
  const vehicleView = await json('GET', `/v1/garage/vehicles/${vehicle.id}`, undefined, userToken);
  assert.equal(vehicleView.identity?.status, 'unverified');
  assert.equal(vehicleView.identity?.model_id, 'tracker');
  assert.equal(vehicleView.identity?.generation_id, null, 'unverified Tracker must not claim an unverified generation');
  assert.equal(vehicleView.identity?.market, null, 'unverified Tracker must not inherit a guessed market');
  assert.equal(garage.vehicle_image?.status, 'approved');
  assert.match(garage.vehicle_image?.url ?? '', /^https:\/\/res\.cloudinary\.com\/mator-isolated-e2e\//);
  const mock = await pipelineMetrics();
  assert.equal(mock.cloudinaryUploads.length, 1, 'only the successful retry should be stored by the Cloudinary stub');
  assert.equal(mock.cloudinaryUploads[0].contentType, 'image/webp');
  record('authenticated approval and Garage delivery', {
    approved: true, modelId: vehicleView.identity.model_id, generationId: vehicleView.identity.generation_id, market: vehicleView.identity.market,
    imageStatus: garage.vehicle_image.status, simulatedCloudinaryUploads: mock.cloudinaryUploads.length,
  });

  const audits = await prisma.adminAudit.count({ where: { actorId, action: 'VEHICLE_IMAGE_APPROVED' } });
  assert.equal(audits, 1, 'successful approval must be audited');
  report.result = 'passed';
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (vehicleIds.length) {
    const vehicles = await prisma.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { imageIdentityKey: true } }).catch(() => []);
    const keys = [...new Set(vehicles.map((item) => item.imageIdentityKey).filter(Boolean))];
    await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } }).catch(() => {});
    if (keys.length) {
      await prisma.vehicleImageOutbox.deleteMany({ where: { identityKey: { in: keys } } }).catch(() => {});
      await prisma.vehicleImageIdentity.deleteMany({ where: { identityKey: { in: keys } } }).catch(() => {});
    }
  }
  if (actorId) await prisma.appAdmin.delete({ where: { id: actorId } }).catch(() => {});
  await prisma.$disconnect();
}

function cryptoRandomString(length) {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}
