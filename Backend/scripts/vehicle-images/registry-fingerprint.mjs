import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Derive the fingerprint from the embedded raw JSON, never a hash declaration. */
export function registryShaFromModuleSource(moduleSource) {
  const embedded = /\bVEHICLE_IMAGE_CATALOG_SOURCE\s*=\s*String\.raw\s*`([\s\S]*?)`\s*;/.exec(moduleSource)?.[1];
  if (!embedded || embedded.includes('${')) return null;
  try {
    const catalog = JSON.parse(embedded);
    if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.assets)) return null;
  } catch { return null; }
  return createHash('sha256').update(embedded).digest('hex');
}

/** Prefer the built data the deployed process uses; malformed built data fails closed. */
export function backendRegistrySha(backendDir) {
  for (const candidate of [
    'dist/src/garage/vehicle-images/vehicle-image-catalog.data.js',
    'src/garage/vehicle-images/vehicle-image-catalog.data.ts',
  ]) {
    const file = path.join(backendDir, candidate);
    if (existsSync(file)) return registryShaFromModuleSource(readFileSync(file, 'utf8'));
  }
  return null;
}

export function registryFingerprintsMatch(backendSha, pipelineSha) {
  return typeof backendSha === 'string' && /^[0-9a-f]{64}$/.test(backendSha) &&
    typeof pipelineSha === 'string' && pipelineSha === backendSha;
}
