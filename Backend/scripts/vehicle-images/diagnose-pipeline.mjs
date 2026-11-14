#!/usr/bin/env node
/**
 * READ-ONLY diagnosis of the backend → Vehicle Image Pipeline connection.
 *
 *   node scripts/vehicle-images/diagnose-pipeline.mjs --env /path/to/Backend/.env
 *   node scripts/vehicle-images/diagnose-pipeline.mjs            (reads process.env)
 *
 * Checks, in order, exactly what the backend does: the settings it would boot
 * with, DNS, a TCP connection, redirects (the backend refuses to follow any),
 * TLS, readiness and the registry fingerprint, then one authenticated
 * `resolve` for a synthetic identity (the pipeline only reads for it; it
 * creates no request, job or file). It never prints a token, never writes a
 * file and never calls `requests`.
 *
 * Exit code: 0 when the backend can use the pipeline, 1 otherwise.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const envIndex = args.indexOf('--env');
const env = { ...process.env };
if (envIndex >= 0) {
  const file = args[envIndex + 1];
  if (!file || !existsSync(file)) {
    console.error('--env needs a readable file');
    process.exit(1);
  }
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !match[1].startsWith('VEHICLE_IMAGE')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    env[match[1]] = value;
  }
}

const findings = [];
const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? `: ${detail}` : ''}`);
const bad = (label, detail, fix) => {
  console.log(`  FAIL  ${label}: ${detail}`);
  findings.push({ label, detail, fix });
};
const info = (label, detail) => console.log(`  info  ${label}: ${detail}`);

/** The registry fingerprint this backend checkout embeds (built or source). */
function backendRegistrySha() {
  for (const candidate of [
    'dist/src/garage/vehicle-images/vehicle-image-catalog.data.js',
    'src/garage/vehicle-images/vehicle-image-catalog.data.ts',
  ]) {
    const file = path.join(backendDir, candidate);
    if (!existsSync(file)) continue;
    const match = /VEHICLE_IMAGE_CATALOG_SHA256\s*=\s*['"]([0-9a-f]{64})['"]/.exec(readFileSync(file, 'utf8'));
    if (match) return match[1];
  }
  return null;
}

function causeCode(err) {
  let current = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current.code === 'string') return current.code;
    if (typeof current.message === 'string' && /redirect/i.test(current.message)) return 'redirect';
    current = current.cause;
  }
  return err?.name ?? 'error';
}

function tcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('ETIMEDOUT'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (err) => done(err.code ?? 'error'));
  });
}

async function get(url, init = {}) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), ...init });
    const text = await response.text();
    return { status: response.status, location: response.headers.get('location'), text };
  } catch (err) {
    return { error: causeCode(err) };
  }
}

console.log('Vehicle image pipeline diagnosis (read-only)\n');
console.log('Settings the backend boots with');
const enabled = String(env.VEHICLE_IMAGES_ENABLED ?? '').trim().toLowerCase() === 'true';
const rawUrl = String(env.VEHICLE_IMAGE_PIPELINE_URL ?? '').trim();
const token = String(env.VEHICLE_IMAGE_REQUEST_TOKEN ?? '').trim();
const adminToken = String(env.VEHICLE_IMAGE_ADMIN_TOKEN ?? '').trim();
info('VEHICLE_IMAGES_ENABLED', enabled ? 'true' : 'false (the backend never calls the pipeline)');
let base = null;
try {
  base = new URL(rawUrl.endsWith('/') ? rawUrl : `${rawUrl}/`);
  info('VEHICLE_IMAGE_PIPELINE_URL', `${base.protocol}//${base.hostname}:${base.port || (base.protocol === 'https:' ? 443 : 80)}${base.pathname}`);
} catch {
  bad('VEHICLE_IMAGE_PIPELINE_URL', rawUrl ? 'not a valid URL' : 'not set', 'Set it to the pipeline base URL, e.g. http://127.0.0.1:8047');
}
if (token.length >= 32 && !/\s/.test(token)) ok('VEHICLE_IMAGE_REQUEST_TOKEN', `set (${token.length} characters)`);
else bad('VEHICLE_IMAGE_REQUEST_TOKEN', token ? 'shorter than 32 characters or contains whitespace' : 'not set',
  'Use the exact VEHICLE_IMAGE_REQUEST_TOKEN from the pipeline env file');
info('VEHICLE_IMAGE_ADMIN_TOKEN', adminToken ? `set (${adminToken.length} characters)` : 'not set (the admin review console stays off)');
const backendSha = backendRegistrySha();
info('backend registry', backendSha ?? 'not found in this checkout');

if (base) {
  console.log('\nNetwork');
  const host = base.hostname.replace(/^\[|\]$/g, '');
  const port = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
  if (!net.isIP(host)) {
    try {
      const addresses = await lookup(host, { all: true });
      ok('DNS', addresses.map((a) => a.address).join(', '));
    } catch (err) {
      bad('DNS', causeCode(err), 'The hostname does not resolve on this server; fix DNS or use the loopback address');
    }
  }
  const connection = await tcp(host, port);
  if (connection === 'connected') ok('TCP', `${host}:${port} accepts connections`);
  else {
    bad('TCP', `${host}:${port} → ${connection}`,
      connection === 'ECONNREFUSED'
        ? 'Nothing listens there: start the pipeline process for this environment (pm2), or point VEHICLE_IMAGE_PIPELINE_URL at the port it listens on'
        : 'The address is unreachable from this server (firewall, wrong host)');
    for (const probe of [8047, 8048]) {
      if (probe !== port) info(`TCP 127.0.0.1:${probe}`, await tcp('127.0.0.1', probe));
    }
  }

  console.log('\nPipeline');
  const live = await get(new URL('health/live', base));
  if (live.error) bad('GET /health/live', live.error, live.error.startsWith('CERT') || live.error.includes('TLS')
    ? 'TLS failed: fix the certificate or use the loopback http URL' : 'See the network checks above');
  else if (live.status >= 300 && live.status < 400)
    bad('GET /health/live', `redirect ${live.status} to ${live.location}`, 'The backend never follows redirects: use the final URL (scheme, host, path, trailing slash)');
  else if (live.status === 200) ok('GET /health/live', 'live');
  else bad('GET /health/live', `HTTP ${live.status}`, 'A proxy or another service answers at this URL; point it at the pipeline');

  const ready = await get(new URL('health/ready', base));
  if (ready.status === 200) {
    let body = {};
    try { body = JSON.parse(ready.text); } catch { /* reported below */ }
    const sha = body?.registry?.sha256 ?? null;
    if (body.status === 'ready') ok('GET /health/ready', `contract ${body.contract ?? 1}, capabilities ${JSON.stringify(body.capabilities ?? null)}`);
    else bad('GET /health/ready', JSON.stringify(body).slice(0, 120), 'The pipeline is not initialised; check its pm2 logs');
    if (!sha) bad('registry handshake', 'the pipeline reports no registry fingerprint', 'Deploy the pipeline release with the registry handshake (contract 2) before this backend');
    else if (backendSha && sha !== backendSha) bad('registry handshake', `pipeline ${sha.slice(0, 12)}… ≠ backend ${backendSha.slice(0, 12)}…`, 'Deploy the same MatorUI- registry commit to the pipeline and the backend');
    else ok('registry handshake', `${sha.slice(0, 12)}… matches`);
  } else if (!ready.error) {
    bad('GET /health/ready', `HTTP ${ready.status}`, 'The pipeline is starting or unhealthy; check its pm2 logs');
  }

  if (token) {
    const identity = {
      makeId: 'diagnostic', modelId: 'diagnostic', modelYear: 2020,
      generationId: null, faceliftId: null, bodyType: null, trimId: null, identityStatus: 'unverified',
    };
    const resolved = await get(new URL('internal/v1/vehicle-images/resolve', base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-mator-vehicle-image-contract': '2',
      },
      body: JSON.stringify({ identity }),
    });
    const expectedKey = createHash('sha256').update(JSON.stringify([
      'mator-vehicle-image-unverified-v1', 'diagnostic', 'diagnostic', 2020, null, null, null, null,
    ])).digest('hex');
    if (resolved.error) bad('authenticated resolve', resolved.error, 'See the network checks above');
    else if (resolved.status === 403) bad('authenticated resolve', 'HTTP 403', 'VEHICLE_IMAGE_REQUEST_TOKEN differs from the pipeline\'s request token');
    else if (resolved.status === 200) {
      let body = {};
      try { body = JSON.parse(resolved.text); } catch { /* reported below */ }
      if (body.identityKey === expectedKey) ok('authenticated resolve', `status ${body.status} (identity hashing agrees)`);
      else if (body.identityKey) bad('authenticated resolve', 'identity key differs', 'The pipeline runs an older identity contract; deploy the current pipeline');
      else bad('authenticated resolve', 'unexpected body', 'Something other than the pipeline answers at this URL');
    } else if (resolved.status === 400) {
      bad('authenticated resolve', 'HTTP 400 (the pipeline refuses the unverified identity class)', 'Deploy the pipeline release that supports unverified identities');
    } else {
      bad('authenticated resolve', `HTTP ${resolved.status}`, 'Check the proxy route and the pipeline logs');
    }
  }
}

console.log('\nVerdict');
if (findings.length === 0) {
  console.log('  The backend can reach and use the pipeline.');
  process.exit(0);
}
for (const finding of findings) console.log(`  - ${finding.label}: ${finding.fix}`);
process.exit(1);
