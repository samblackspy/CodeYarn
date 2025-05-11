const path = require('path');

module.exports = {
  apps: [
    {
      name: 'codeyarn-server',
      cwd: path.join(__dirname, 'apps/server'),
      script: path.join(__dirname, 'apps/server/dist/index.js'),
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: "postgresql://codeyarn_user:your_strong_secret_password@localhost:5432/codeyarn_db?schema=public",
},
    },
    {
      name: 'codeyarn-web',
      cwd: path.join(__dirname, 'apps/web'),
      script: path.join(__dirname, 'apps/web/node_modules/next/dist/bin/next'),
      args: 'start',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
