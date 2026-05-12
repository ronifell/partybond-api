import http from 'node:http';
import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { initSocket } from './socket';
import { startCleanupJobs } from './services/cleanupService';
import { getFirebaseAdmin } from './config/firebase';

async function main() {
  const app = buildApp();
  const server = http.createServer(app);

  initSocket(server);
  getFirebaseAdmin(); // lazy-init log
  startCleanupJobs();

  server.listen(env.port, () => {
    logger.info(`Partybond API ready at ${env.appUrl} (env=${env.nodeEnv})`);
  });

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
