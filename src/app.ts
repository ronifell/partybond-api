import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';

import { env, isProd } from './config/env';
import { getFirebaseAdmin } from './config/firebase';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { asyncHandler } from './utils/asyncHandler';
import {
  findGameImageFile,
  GAME_ID_REGEX,
  GAME_IMAGE_MIME_BY_EXT,
} from './services/gameImageService';

import { authRouter } from './controllers/authController';
import { userRouter } from './controllers/userController';
import { gameRouter } from './controllers/gameController';
import { sessionRouter } from './controllers/sessionController';
import { matchRouter } from './controllers/matchController';
import { matchmakingRouter } from './controllers/matchmakingController';
import { groupsRouter } from './controllers/groupsController';
import { chatRouter } from './controllers/chatController';
import { moderationRouter } from './controllers/moderationController';
import { adminRouter } from './controllers/adminController';
import { billingRouter } from './controllers/billingController';
import { referralRouter, inviteRedirectRouter } from './controllers/referralController';
import { autoGroupRouter } from './controllers/autoGroupController';

export function buildApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // Nginx reverse proxy sets X-Forwarded-*; required for rate-limit + req.ip in production.
  if (isProd) app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: env.clientOrigins.includes('*') ? true : env.clientOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(isProd ? 'combined' : 'dev'));

  // Light global rate limit (tighten per-route in prod)
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  // Static for uploaded images
  app.use('/uploads', express.static(path.resolve(env.uploadDir)));

  // Game thumbnails by id — resolves png/jpg/webp/gif (e.g. /game-images/valorant)
  app.get(
    '/game-images/:gameId',
    asyncHandler(async (req, res) => {
      const { gameId } = req.params;
      if (!GAME_ID_REGEX.test(gameId)) {
        res.status(400).json({ error: { code: 'invalid_game_id', message: 'Invalid game id' } });
        return;
      }

      const match = await findGameImageFile(gameId);
      if (!match) {
        res.status(404).json({ error: { code: 'not_found', message: 'Game image not found' } });
        return;
      }

      const contentType =
        GAME_IMAGE_MIME_BY_EXT[match.ext as keyof typeof GAME_IMAGE_MIME_BY_EXT] ??
        'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.sendFile(match.filePath);
    }),
  );

  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  /**
   * Simulate / document teammate signaling without Firebase.
   * `curl -s http://localhost:4000/health/communication | jq`
   */
  app.get('/health/communication', (_req, res) => {
    const firebasePushConfigured = !!getFirebaseAdmin();
    res.json({
      ok: true,
      ts: Date.now(),
      firebasePushConfigured,
      withoutFirebaseServiceAccountJson: {
        canTeammatesCommunicateInApp: true,
        mechanism: [
          'REST POST /api/v1/matches/:id/interactions stores each quick action.',
          'Server emits Socket.IO match:interaction to the other user (emitToUser).',
          'GET /api/v1/matches/:id includes interactions[] for Live updates after refetch.',
        ],
        requires: 'Both users connected to the same API + Socket (app open or socket alive).',
      },
      firebaseOnlyAdds: {
        fcmTrayWhenBackgroundedOrKilled: true,
      },
    });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', userRouter);
  app.use('/api/v1/games', gameRouter);
  app.use('/api/v1/sessions', sessionRouter);
  app.use('/api/v1/matches', matchRouter);
  app.use('/api/v1/matchmaking', matchmakingRouter);
  app.use('/api/v1/groups', groupsRouter);
  app.use('/api/v1/chats', chatRouter);
  app.use('/api/v1/moderation', moderationRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/billing', billingRouter);
  app.use('/api/v1/referrals', referralRouter);
  app.use('/api/v1/auto-groups', autoGroupRouter);

  // Public invite landing page: GET /i/<code> → Play Store / App Store / HTML page.
  // No /api/v1 prefix so the share URL is short & friendly to paste anywhere.
  app.use('/i', inviteRedirectRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
