import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { requirePremium } from '../services/premiumService';
import { asyncHandler } from '../utils/asyncHandler';
import {
  cancelAutoGroup,
  getAutoGroupStatus,
  listMyAutoGroupRequests,
  startAutoGroup,
} from '../services/autoGroupService';
import { MAX_USER_AGE, MIN_USER_AGE } from '../config/userPolicy';

export const autoGroupRouter = Router();

const createSchema = z.object({
  name: z.string().min(2).max(60),
  gameId: z.string().min(1),
  gameMode: z.enum(['casual', 'competitive']),
  playStyle: z.enum(['relaxed', 'focused']),
  skillTier: z.enum(['beginner', 'intermediate', 'advanced', 'veteran']),
  playersNeeded: z.coerce.number().int().min(2).max(16),
  minAge: z.coerce.number().int().min(MIN_USER_AGE).max(MAX_USER_AGE).optional(),
  maxAge: z.coerce.number().int().min(MIN_USER_AGE).max(MAX_USER_AGE).optional(),
});

autoGroupRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const requests = await listMyAutoGroupRequests(req.userId!);
    res.json({ requests });
  }),
);

autoGroupRouter.post(
  '/',
  requireAuth,
  requirePremium,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const status = await startAutoGroup(req.userId!, body);
    res.status(201).json({ request: status });
  }),
);

autoGroupRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = await getAutoGroupStatus(req.userId!, req.params.id);
    res.json({ request: status });
  }),
);

autoGroupRouter.post(
  '/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await cancelAutoGroup(req.userId!, req.params.id);
    res.json(result);
  }),
);
