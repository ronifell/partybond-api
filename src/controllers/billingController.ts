import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { env } from '../config/env';
import {
  listMySubscriptions,
  refreshUserSubscriptions,
  verifyGooglePlayPurchase,
} from '../services/billingService';
import { getPremiumStatus } from '../services/premiumService';

export const billingRouter = Router();

const verifySchema = z.object({
  productId: z.string().min(1).max(120),
  purchaseToken: z.string().min(8).max(2048),
});

/** Public — surfaces which product IDs the client should buy. */
billingRouter.get(
  '/products',
  asyncHandler(async (_req, res) => {
    res.json({
      premiumProductIds: env.googlePlay.premiumProductIds,
      playPackageName: env.googlePlay.packageName,
    });
  }),
);

/** Returns the caller's current premium status + active subscriptions. */
billingRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = await getPremiumStatus(req.userId!);
    const subscriptions = await listMySubscriptions(req.userId!);
    res.json({ status, subscriptions });
  }),
);

/** Force a re-verify of every active subscription for the caller. */
billingRouter.post(
  '/refresh',
  requireAuth,
  asyncHandler(async (req, res) => {
    await refreshUserSubscriptions(req.userId!);
    const status = await getPremiumStatus(req.userId!);
    const subscriptions = await listMySubscriptions(req.userId!);
    res.json({ status, subscriptions });
  }),
);

/**
 * Called by the Android app right after Google Play returns a purchase token.
 * Server-side validates the token, persists the subscription, and bumps premium.
 */
billingRouter.post(
  '/google-play/verify',
  requireAuth,
  validate(verifySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof verifySchema>;
    const subscription = await verifyGooglePlayPurchase(req.userId!, body);
    const status = await getPremiumStatus(req.userId!);
    res.json({ subscription, status });
  }),
);
