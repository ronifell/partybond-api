import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { env } from '../config/env';
import { HttpError } from '../utils/httpError';
import {
  listMySubscriptions,
  refreshUserSubscriptions,
  simulatePremiumPurchase,
  verifyGooglePlayPurchase,
} from '../services/billingService';
import { getPremiumStatus } from '../services/premiumService';

export const billingRouter = Router();

const verifySchema = z.object({
  productId: z.string().min(1).max(120),
  purchaseToken: z.string().min(8).max(2048),
});

const mockPurchaseSchema = z.object({
  productId: z.string().min(1).max(120).optional(),
  durationDays: z.number().int().min(1).max(3650).optional(),
});

/**
 * Public — tells the client which product IDs to surface and which billing
 * providers are enabled (so it can pick the right purchase flow).
 */
billingRouter.get(
  '/products',
  asyncHandler(async (_req, res) => {
    res.json({
      premiumProductIds: env.googlePlay.premiumProductIds,
      playPackageName: env.googlePlay.packageName,
      googlePlayConfigured: env.googlePlay.isConfigured,
      mockEnabled: env.billingMock.enabled,
      mockDurationDays: env.billingMock.durationDays,
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

/**
 * Mock provider — pretends a Play / App Store purchase succeeded and grants
 * premium for `BILLING_MOCK_DURATION_DAYS`. Only reachable when
 * `BILLING_MOCK_ENABLED=true`. Intended as a stand-in until the real billing
 * pipeline is set up; the client picks this route automatically when
 * `/billing/products` reports `mockEnabled: true`.
 */
billingRouter.post(
  '/mock/purchase',
  requireAuth,
  validate(mockPurchaseSchema),
  asyncHandler(async (req, res) => {
    if (!env.billingMock.enabled) {
      throw HttpError.notFound('Mock billing is disabled', 'mock_billing_disabled');
    }
    const body = req.body as z.infer<typeof mockPurchaseSchema>;
    const subscription = await simulatePremiumPurchase(req.userId!, body);
    const status = await getPremiumStatus(req.userId!);
    res.json({ subscription, status });
  }),
);
