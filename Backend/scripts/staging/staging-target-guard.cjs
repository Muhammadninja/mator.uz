'use strict';

const STAGING_DB = 'mator_staging';
const STAGING_ROLE = 'mator_backend_staging';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function validateStagingTarget(env) {
  const errors = [];
  if (env.NODE_ENV !== 'staging') errors.push('NODE_ENV must be staging');
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    let url;
    try { url = new URL(env[key]); } catch { errors.push(`${key} is missing or invalid`); continue; }
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const username = decodeURIComponent(url.username);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) errors.push(`${key} must use PostgreSQL`);
    if (!LOOPBACK.has(url.hostname)) errors.push(`${key} must target loopback only`);
    if (database !== STAGING_DB) errors.push(`${key} must target ${STAGING_DB}`);
    if (username !== STAGING_ROLE) errors.push(`${key} must use ${STAGING_ROLE}`);
  }
  if (env.SEED_ADMIN_EMAIL || env.SEED_ADMIN_PASSWORD)
    errors.push('staging seed must not bootstrap an admin from environment credentials');
  return errors;
}

module.exports = { validateStagingTarget };

if (require.main === module) {
  const errors = validateStagingTarget(process.env);
  if (errors.length) {
    console.error(`Staging database target refused: ${errors.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('Staging database target verified (loopback, mator_staging, restricted role).');
  }
}
