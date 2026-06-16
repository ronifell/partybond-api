import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';

/**
 * The set of "live" statuses that entitle a user to premium features.
 * "canceled" still entitles them until currentPeriodEnd (Google Play / Apple policy).
 */
const ENTITLING_STATUSES = ['active', 'trial', 'grace', 'canceled'] as const;

/**
 * Recomputes a user's `premiumUntil` from their subscription rows. Takes the max
 * `currentPeriodEnd` across all entitling subscriptions. Idempotent — call this
 * any time billing or referral state changes.
 */
export async function syncPremiumUntil(userId: string): Promise<Date | null> {
  const subs = await prisma.subscription.findMany({
    where: {
      userId,
      status: { in: [...ENTITLING_STATUSES] },
    },
    select: { currentPeriodEnd: true },
  });

  let max: Date | null = null;
  for (const s of subs) {
    if (!max || s.currentPeriodEnd > max) max = s.currentPeriodEnd;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { premiumUntil: max },
  });
  return max;
}

export interface PremiumStatus {
  isPremium: boolean;
  /** When the current entitlement runs out (null if never premium). */
  premiumUntil: string | null;
  /** True when the cached `premiumUntil` is in the past — caller can re-sync. */
  isStale: boolean;
}

/** Fast O(1) check: read the cached `premiumUntil` column. */
export async function getPremiumStatus(userId: string): Promise<PremiumStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { premiumUntil: true },
  });
  const until = user?.premiumUntil ?? null;
  const now = new Date();
  return {
    isPremium: !!until && until > now,
    premiumUntil: until ? until.toISOString() : null,
    isStale: !!until && until <= now,
  };
}

/**
 * Express middleware — gate a route to premium users only.
 * Re-checks subscriptions on cache miss so users who just paid don't bounce.
 */
export async function requirePremium(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.userId;
    if (!userId) {
      next(HttpError.unauthorized('Missing bearer token'));
      return;
    }
    const status = await getPremiumStatus(userId);
    if (status.isPremium) {
      next();
      return;
    }
    // Cache may be stale (expired/just-renewed); resync once before failing.
    const refreshed = await syncPremiumUntil(userId);
    if (refreshed && refreshed > new Date()) {
      next();
      return;
    }
    next(HttpError.forbidden('Premium subscription required', 'premium_required'));
  } catch (err) {
    next(err);
  }
}
