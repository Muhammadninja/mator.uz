'use strict';

const { validateStagingTarget } = require('./staging-target-guard.cjs');

function validateStagingRuntime(env) {
  const errors = validateStagingTarget(env);
  if (env.VEHICLE_IMAGE_PIPELINE_URL !== 'http://127.0.0.1:8048')
    errors.push('vehicle image pipeline must be the staging loopback endpoint');
  if (env.VEHICLE_IMAGES_ENABLED !== 'true')
    errors.push('vehicle images must be explicitly enabled for staging integration checks');
  if (env.REDIS_HOST !== '127.0.0.1' || env.REDIS_PORT !== '6380')
    errors.push('Redis must be the isolated staging loopback instance');
  if (!env.VEHICLE_IMAGE_REQUEST_TOKEN || env.VEHICLE_IMAGE_REQUEST_TOKEN.length < 32 ||
      /replace-with|placeholder/i.test(env.VEHICLE_IMAGE_REQUEST_TOKEN))
    errors.push('staging vehicle image request token is missing or invalid');
  return errors;
}

module.exports = { validateStagingRuntime };

if (require.main === module) {
  const errors = validateStagingRuntime(process.env);
  if (errors.length) {
    console.error(`Staging runtime refused: ${errors.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('Staging runtime verified (database and image pipeline targets are staging-only).');
  }
}
