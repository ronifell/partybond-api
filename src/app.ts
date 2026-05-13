import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'node:path';

import { env, isProd } from './config/env';
import { getFirebaseAdmin } from './config/firebase';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';

import { authRouter } from './controllers/authController';
import { userRouter } from './controllers/userController';
import { gameRouter } from './controllers/gameController';
import { sessionRouter } from './controllers/sessionController';
import { matchRouter } from './controllers/matchController';

export function buildApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
