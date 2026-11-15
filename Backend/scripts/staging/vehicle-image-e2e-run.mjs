#!/usr/bin/env node
/** Runs the committed Tracker E2E with a local Pipeline publication stub. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const state = path.resolve(process.env.MATOR_INTEGRATION_DIR || path.join(process.env.HOME || '.', '.mator/vehicle-image-e2e-state'));
const source = path.resolve(process.env.VEHICLE_IMAGE_PIPELINE_SOURCE || path.join(state, 'pipeline-source'));
const backendEnv = JSON.parse(await fs.readFile(path.join(state, 'environment.json'), 'utf8'));
const pipelineEnv = JSON.parse(await fs.readFile(path.join(state, 'pipeline-environment.json'), 'utf8'));
const backend = path.join(state, 'backend');
const requireFromBackend = createRequire(path.join(backend, 'package.json'));
const { VEHICLE_IMAGE_REGISTRY_SHA256: registry } =
  requireFromBackend(path.join(backend, 'dist/src/garage/vehicle-images/vehicle-image.catalog.js'));
const requestToken = pipelineEnv.VEHICLE_IMAGE_REQUEST_TOKEN;
const adminToken = pipelineEnv.VEHICLE_IMAGE_ADMIN_TOKEN;
if (!requestToken || requestToken !== backendEnv.VEHICLE_IMAGE_REQUEST_TOKEN ||
    !adminToken || adminToken !== backendEnv.VEHICLE_IMAGE_ADMIN_TOKEN) {
  throw new Error('isolated backend and pipeline service tokens do not match');
}
await fs.access(path.join(source, 'services/package.json'));
const apiPort = Number(process.env.MATOR_API_PORT || backendEnv.PORT || 3300);
const pipelinePort = Number(process.env.VEHICLE_IMAGE_E2E_PIPELINE_PORT || 38048);
const proxyPort = Number(process.env.VEHICLE_IMAGE_E2E_PROXY_PORT || 38049);
const backendPipeline = new URL(backendEnv.VEHICLE_IMAGE_PIPELINE_URL || 'http://127.0.0.1:0');
if (backendPipeline.hostname !== '127.0.0.1' || Number(backendPipeline.port) !== proxyPort)
  throw new Error('Backend VEHICLE_IMAGE_PIPELINE_URL must target the loopback proxy port');
const dataDir = path.join(state, 'pipeline-runs', Date.now() + '-' + randomBytes(4).toString('hex'));
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const scripts = path.dirname(new URL(import.meta.url).pathname);
const safeEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'development' };
const host = spawn(process.execPath, [path.join(scripts, 'vehicle-image-e2e-pipeline-host.mjs')], {
  stdio: 'inherit',
  env: {
    ...safeEnv,
    VEHICLE_IMAGE_PIPELINE_SOURCE: source,
    VEHICLE_IMAGE_E2E_PIPELINE_DATA: dataDir,
    VEHICLE_IMAGE_REGISTRY_SHA256: registry,
    VEHICLE_IMAGE_REQUEST_TOKEN: requestToken,
    VEHICLE_IMAGE_ADMIN_TOKEN: adminToken,
    VEHICLE_IMAGE_GENERATION_ENABLED: 'false',
    VEHICLE_IMAGE_PUBLICATION_ENABLED: 'true',
    VEHICLE_IMAGE_E2E_PIPELINE_PORT: String(pipelinePort),
    VEHICLE_IMAGE_E2E_PROXY_PORT: String(proxyPort),
  },
});
let hostExited = false;
host.once('exit', () => { hostExited = true; });
let result = 1;
try {
  const until = Date.now() + 20000;
  let ready = false;
  while (Date.now() < until && !hostExited) {
    try {
      const response = await fetch('http://127.0.0.1:' + pipelinePort + '/health/ready', { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.status === 'ready' && health.contract === 2 && health.registry?.sha256 === registry) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('isolated contract-2 Pipeline did not become ready');
  const test = spawn(process.execPath, [path.join(scripts, 'vehicle-image-single-tracker-e2e.mjs')], {
    stdio: 'inherit',
    env: { ...safeEnv, MATOR_INTEGRATION_DIR: state, MATOR_API_PORT: String(apiPort), VEHICLE_IMAGE_E2E_PROXY_PORT: String(proxyPort) },
  });
  result = await new Promise((resolve, reject) => {
    test.once('error', reject);
    test.once('exit', code => resolve(code ?? 1));
  });
} finally {
  if (!hostExited) {
    host.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      host.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (!hostExited) host.kill('SIGKILL');
  }
}
process.exitCode = result;
