#!/usr/bin/env node
// Read-only authenticated check of staging backend -> pipeline -> Garage image status.
const EXPECTED_BACKEND = 'http://127.0.0.1:3001';
const EXPECTED_PIPELINE = 'http://127.0.0.1:8048';
const timeout = AbortSignal.timeout(5000);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv.includes('--help')) {
  console.log('Set MATOR_STAGING_CONFIRM=vehicle-image-staging, MATOR_STAGING_ACCESS_TOKEN, and MATOR_STAGING_GARAGE_VEHICLE_ID; then run this script.');
  process.exit(0);
}
if (process.env.MATOR_STAGING_CONFIRM !== 'vehicle-image-staging')
  fail('Refusing without MATOR_STAGING_CONFIRM=vehicle-image-staging.');
if (process.env.MATOR_STAGING_BACKEND_URL !== EXPECTED_BACKEND ||
    process.env.MATOR_STAGING_PIPELINE_URL !== EXPECTED_PIPELINE)
  fail('Refusing: staging URLs must be the configured loopback endpoints.');
const token = process.env.MATOR_STAGING_ACCESS_TOKEN;
const vehicleId = process.env.MATOR_STAGING_GARAGE_VEHICLE_ID;
if (!token || !vehicleId) fail('Staging access token and Garage vehicle ID are required.');
const expectation = process.env.MATOR_STAGING_EXPECT_STATUS;
if (expectation && !['pending', 'approved', 'unavailable'].includes(expectation))
  fail('Expected status must be pending, approved, or unavailable.');

async function get(url, headers = {}) {
  try {
    return await fetch(url, { headers, signal: timeout, redirect: 'error' });
  } catch {
    fail('A staging health or Garage request failed.');
  }
}

const pipeline = await get(`${EXPECTED_PIPELINE}/health/ready`);
if (pipeline.status !== 200) fail(`Staging pipeline readiness returned HTTP ${pipeline.status}.`);
const backend = await get(`${EXPECTED_BACKEND}/health/live`);
if (backend.status !== 200) fail(`Staging backend liveness returned HTTP ${backend.status}.`);
const imageResponse = await get(
  `${EXPECTED_BACKEND}/v1/garage/vehicles/${encodeURIComponent(vehicleId)}/image`,
  { authorization: `Bearer ${token}` },
);
if (!imageResponse.ok) fail(`Staging Garage image endpoint returned HTTP ${imageResponse.status}.`);
let payload;
try { payload = await imageResponse.json(); } catch { fail('Staging Garage response was not JSON.'); }
const image = payload?.vehicle_image;
if (payload?.vehicle_id !== vehicleId || !image ||
    !['pending', 'approved', 'unavailable'].includes(image.status))
  fail('Staging Garage response did not match the vehicle image contract.');
if (image.status === 'approved') {
  const published = typeof image.url === 'string' && image.url.startsWith('https://');
  const bundled = typeof image.catalog_asset_key === 'string' && image.catalog_asset_key.length > 0;
  if ((!published && !bundled) || !Number.isInteger(image.version))
    fail('Approved staging image is missing a valid HTTPS URL or approved catalog key/version.');
}
if (expectation && image.status !== expectation)
  fail(`Garage image status was ${image.status}; expected ${expectation}.`);
console.log(`Staging backend and pipeline healthy; Garage image status=${image.status}; version=${image.version ?? 'none'}.`);
