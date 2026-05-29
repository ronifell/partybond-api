import http from 'node:http';
import { buildApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { getGameImagesDir } from './services/gameImageService';
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
    logger.info({ gameImagesDir: getGameImagesDir() }, 'Game images directory');
    if (env.mail.isConfigured) {
      logger.info(
        {
          mailUser: env.mail.username,
          passLength: env.mail.password.length,
          cwd: process.cwd(),
        },
        env.mail.password.length === 16
          ? 'SMTP mail configured'
          : 'SMTP mail MISCONFIGURED — MAIL_PASSWORD must be 16 chars; run npm run test:smtp',
      );
    }
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
