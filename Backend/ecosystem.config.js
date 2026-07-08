// PM2 process definition for the Mator backend.
// Cluster mode is intentionally not used: TelegramService keeps in-memory
// state (media-group buffers, long-polling connection) that isn't safe to
// share across multiple worker processes.
module.exports = {
  apps: [
    {
      name: 'mator-backend',
      script: 'dist/src/main.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env_production: {
        NODE_ENV: 'production',
      },
      // Give app.enableShutdownHooks() time to run OnModuleDestroy (e.g. the
      // Telegram bot stopping cleanly) before PM2 sends SIGKILL.
      kill_timeout: 5000,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
