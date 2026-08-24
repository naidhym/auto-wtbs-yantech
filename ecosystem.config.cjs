module.exports = {
  apps: [
    {
      name: 'auto-wtb-bot',
      cwd: __dirname,
      script: 'dist/index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 15000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
