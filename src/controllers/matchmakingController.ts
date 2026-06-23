import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  joinGlobalQueue,
  leaveGlobalQueue,
  getGlobalQueueStatus,
} from '../services/progressiveMatchmakingService';
import { gamePlatformSchema } from '../constants/gamePlatform';

export const matchmakingRouter = Router();

const joinSchema = z.object({
  gameId: z.string().min(1),
  gameMode: z.enum(['casual', 'competitive']),
  playStyle: z.enum(['relaxed', 'focused']),
  platform: gamePlatformSchema,
});

matchmakingRouter.post(
  '/queue',
  requireAuth,
  validate(joinSchema),
  asyncHandler(async (req, res) => {
    await joinGlobalQueue(req.userId!, req.body);
    const status = await getGlobalQueueStatus(req.userId!);
    res.json({ ok: true, status });
  }),
);

matchmakingRouter.delete(
  '/queue',
  requireAuth,
  asyncHandler(async (req, res) => {
    await leaveGlobalQueue(req.userId!);
    res.json({ ok: true });
  }),
);

matchmakingRouter.get(
  '/queue/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = await getGlobalQueueStatus(req.userId!);
    res.json({ status });
  }),
);
