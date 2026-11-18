import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendRegistrySha, registryFingerprintsMatch, registryShaFromModuleSource } from './registry-fingerprint.mjs';

const json = '{\n  "version": 1,\n  "assets": [{"id":"retained-mapping"}]\n}\n';
const sha = createHash('sha256').update(json).digest('hex');
const source = 'export const VEHICLE_IMAGE_CATALOG_SOURCE = String.raw`' + json + '`;\n' +
  "export const VEHICLE_IMAGE_CATALOG_SHA256 = createHash('sha256').update(VEHICLE_IMAGE_CATALOG_SOURCE).digest('hex');";
const built = 'exports.VEHICLE_IMAGE_CATALOG_SOURCE = String.raw `' + json + '`;\n' +
  'exports.VEHICLE_IMAGE_CATALOG_SHA256 = (0, node_crypto_1.createHash)("sha256").update(exports.VEHICLE_IMAGE_CATALOG_SOURCE).digest("hex");';
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mator-registry-diagnosis-'));
  directories.push(root);
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}
const sourcePath = 'src/garage/vehicle-images/vehicle-image-catalog.data.ts';
const builtPath = 'dist/src/garage/vehicle-images/vehicle-image-catalog.data.js';

test('derives source data fingerprint with a dynamic checksum declaration', () => {
  assert.equal(registryShaFromModuleSource(source), sha);
  assert.equal(backendRegistrySha(fixture({ [sourcePath]: source })), sha);
});

test('derives compiled data fingerprint with a dynamic checksum declaration', () => {
  assert.equal(registryShaFromModuleSource(built), sha);
  assert.equal(backendRegistrySha(fixture({ [builtPath]: built })), sha);
});

test('reads the actual generated canonical source without relying on a checksum literal', () => {
  const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const generated = readFileSync(path.join(backend, sourcePath), 'utf8');
  const embedded = generated.split('String.raw`')[1].split('`;')[0];
  assert.equal(registryShaFromModuleSource(generated), createHash('sha256').update(embedded).digest('hex'));
});

test('uses deployed built bytes instead of concealing their drift with newer source', () => {
  const changed = built.replace('retained-mapping', 'different-mapping');
  const changedSha = registryShaFromModuleSource(changed);
  assert.notEqual(changedSha, sha);
  assert.equal(backendRegistrySha(fixture({ [sourcePath]: source, [builtPath]: changed })), changedSha);
});

test('fails closed for missing, malformed, interpolated, or checksum-only data', () => {
  for (const value of ['', 'VEHICLE_IMAGE_CATALOG_SHA256 = "' + sha + '";',
    'VEHICLE_IMAGE_CATALOG_SOURCE = String.raw`not json`;',
    'VEHICLE_IMAGE_CATALOG_SOURCE = String.raw`{"assets":[],"value":"${untrusted}"}`;']) {
    assert.equal(registryShaFromModuleSource(value), null);
    assert.equal(registryFingerprintsMatch(null, sha), false);
  }
  assert.equal(backendRegistrySha(fixture({})), null);
  assert.equal(backendRegistrySha(fixture({ [sourcePath]: source, [builtPath]: 'malformed' })), null);
});

test('only a known valid matching pair passes the handshake', () => {
  assert.equal(registryFingerprintsMatch(sha, sha), true);
  assert.equal(registryFingerprintsMatch(sha, '0'.repeat(64)), false);
  assert.equal(registryFingerprintsMatch(null, null), false);
  assert.equal(registryFingerprintsMatch('unknown', 'unknown'), false);
});
