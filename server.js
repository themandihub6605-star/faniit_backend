const app = require('./src/app');
const connectDB = require('./src/config/db');
const env = require('./src/config/env');

async function start() {
  await connectDB();

  const server = app.listen(env.port, () => {
    console.log(`[server] Fanitt API running on port ${env.port} (${env.env})`);
  });

  process.on('unhandledRejection', (err) => {
    console.error('[server] Unhandled rejection:', err.message);
    server.close(() => process.exit(1));
  });

  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received, shutting down gracefully');
    server.close(() => process.exit(0));
  });
}

start();
