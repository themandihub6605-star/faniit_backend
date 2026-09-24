const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const env = require('./src/config/env');
const { initSocket } = require('./src/config/socket');
const { runAutoReleaseSweep } = require('./src/services/milestone.service');

const AUTO_RELEASE_INTERVAL_MS = 15 * 60 * 1000;

async function start() {
  await connectDB();

  const httpServer = http.createServer(app);
  initSocket(httpServer);

  const server = httpServer.listen(env.port, () => {
    console.log(`[server] Fanitt API running on port ${env.port} (${env.env})`);
  });

  // Releases submitted milestones the brand didn't review in time.
  const sweep = () => runAutoReleaseSweep().catch((err) => console.error('[auto-release] failed:', err.message));
  setTimeout(sweep, 30 * 1000);
  setInterval(sweep, AUTO_RELEASE_INTERVAL_MS);

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