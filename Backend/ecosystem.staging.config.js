// Isolated loopback-only backend for Garage image pipeline staging.
// scripts/staging/start-backend-staging.sh clears inherited process env before Node starts.
module.exports = {
  apps: [{
    name: 'mator-backend-staging',
    script: 'scripts/staging/start-backend-staging.sh',
    interpreter: '/bin/bash',
    cwd: __dirname,
    uid: 'mator-backend-staging',
    gid: 'mator-backend-staging',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    kill_timeout: 10000,
    out_file: '/var/log/mator/backend-staging/out.log',
    error_file: '/var/log/mator/backend-staging/error.log',
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: 'staging',
      PORT: '3001',
      BIND_HOST: '127.0.0.1',
      DOTENV_CONFIG_PATH: '/etc/mator/backend-staging.env',
    },
  }],
};
