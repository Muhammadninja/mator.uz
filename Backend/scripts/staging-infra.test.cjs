'use strict';

const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateStagingTarget } = require('./staging/staging-target-guard.cjs');

const root = path.resolve(__dirname, '..');
const validEnv = {
  NODE_ENV: 'staging',
  DATABASE_URL: 'postgresql://mator_backend_staging:pw@127.0.0.1:5432/mator_staging?schema=public',
  DIRECT_URL: 'postgresql://mator_backend_staging:pw@localhost:5432/mator_staging?schema=public',
};

test('staging DB guard accepts only the dedicated loopback database and role', () => {
  assert.deepEqual(validateStagingTarget(validEnv), []);
  assert.match(validateStagingTarget({ ...validEnv, DATABASE_URL: validEnv.DATABASE_URL.replace('127.0.0.1', 'db.production.internal') }).join(' '), /loopback/);
  assert.match(validateStagingTarget({ ...validEnv, DIRECT_URL: validEnv.DIRECT_URL.replace('mator_staging', 'mator') }).join(' '), /mator_staging/);
  assert.match(validateStagingTarget({ ...validEnv, NODE_ENV: 'production' }).join(' '), /NODE_ENV/);
  assert.match(validateStagingTarget({ ...validEnv, SEED_ADMIN_PASSWORD: 'present' }).join(' '), /bootstrap an admin/);
});

test('PM2 staging config is a dedicated loopback fork and uses the staging launcher', () => {
  const pm2 = require('../ecosystem.staging.config.js').apps[0];
  assert.equal(pm2.name, 'mator-backend-staging');
  assert.equal(pm2.exec_mode, 'fork');
  assert.equal(pm2.instances, 1);
  assert.equal(pm2.uid, 'mator-backend-staging');
  assert.equal(pm2.env.BIND_HOST, '127.0.0.1');
  assert.equal(pm2.env.PORT, '3001');
  assert.match(pm2.script, /start-backend-staging\.sh$/);
  assert.equal(pm2.env.DOTENV_CONFIG_PATH, '/etc/mator/backend-staging.env');
});

test('staging launcher sanitizes inherited environment and fixes pipeline endpoint', () => {
  const launcher = readFileSync(path.join(root, 'scripts/staging/start-backend-staging.sh'), 'utf8');
  assert.match(launcher, /env -i/);
  assert.match(launcher, /DOTENV_CONFIG_PATH=\/etc\/mator\/backend-staging\.env/);
  assert.match(launcher, /BIND_HOST=127\.0\.0\.1/);
  const envExample = readFileSync(path.join(root, 'deploy/staging/backend-staging.env.example'), 'utf8');
  assert.match(envExample, /^VEHICLE_IMAGE_PIPELINE_URL=http:\/\/127\.0\.0\.1:8048$/m);
  assert.match(envExample, /^VEHICLE_IMAGES_ENABLED=true$/m);
  const redis = readFileSync(path.join(root, 'deploy/staging/redis-mator-staging.conf.example'), 'utf8');
  assert.match(redis, /^bind 127\.0\.0\.1$/m);
  assert.match(redis, /^port 6380$/m);
  assert.match(redis, /^aclfile \/etc\/redis\/users-mator-staging\.acl$/m);
});

test('staging database tools are guarded and usage mode performs no DB work', () => {
  for (const script of ['create-staging-db.sh', 'prisma-staging.sh']) {
    const result = spawnSync('bash', [`scripts/staging/${script}`, '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
  const refused = spawnSync('bash', ['scripts/staging/create-staging-db.sh', '--apply'], {
    cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing/);
});

test('staging shell scripts parse without executing infrastructure commands', () => {
  const scripts = [
    'scripts/staging/start-backend-staging.sh',
    'scripts/staging/create-staging-db.sh',
    'scripts/staging/prisma-staging.sh',
  ];
  for (const script of scripts) {
    const result = spawnSync('bash', ['-n', script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test('smoke test refuses non-staging calls before making network requests', () => {
  const result = spawnSync(process.execPath, ['scripts/staging/vehicle-image-smoke.mjs'], {
    cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing/);
});
