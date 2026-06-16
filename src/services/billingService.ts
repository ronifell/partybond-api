import type { Prisma, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { getGooglePlayAccessToken } from '../config/googlePlay';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { track } from './analyticsService';
import { syncPremiumUntil } from './premiumService';

// -----------------------------------------------------------------------------
// Google Play "purchases.subscriptionsv2.get" response shape (subset we care about)
// https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
// -----------------------------------------------------------------------------

type GoogleSubscriptionState =
  | 'SUBSCRIPTION_STATE_UNSPECIFIED'
  | 'SUBSCRIPTION_STATE_PENDING'
  | 'SUBSCRIPTION_STATE_ACTIVE'
  | 'SUBSCRIPTION_STATE_PAUSED'
  | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
  | 'SUBSCRIPTION_STATE_ON_HOLD'
  | 'SUBSCRIPTION_STATE_CANCELED'
  | 'SUBSCRIPTION_STATE_EXPIRED';

interface GoogleSubscriptionLineItem {
  productId: string;
  expiryTime?: string;
  autoRenewingPlan?: { autoRenewEnabled?: boolean };
  prepaidPlan?: { allowExtendAfterTime?: string };
}

interface GoogleSubscriptionPurchaseV2 {
  kind?: string;
  regionCode?: string;
  lineItems?: GoogleSubscriptionLineItem[];
  startTime?: string;
  subscriptionState?: GoogleSubscriptionState;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  canceledStateContext?: unknown;
  pausedStateContext?: unknown;
  acknowledgementState?: string;
}

const STATE_MAP: Record<GoogleSubscriptionState, SubscriptionStatus> = {
  SUBSCRIPTION_STATE_UNSPECIFIED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'trial',
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace',
  SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
  SUBSCRIPTION_STATE_CANCELED: 'canceled',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
};

/**
 * "Granting" states still entitle the user to premium features.
 * Canceled subscriptions remain active until `currentPeriodEnd` per Play policy.
 */
const ENTITLING_STATUSES: SubscriptionStatus[] = ['active', 'trial', 'grace', 'canceled'];

export function isEntitlingStatus(status: SubscriptionStatus): boolean {
  return ENTITLING_STATUSES.includes(status);
}

async function fetchGooglePlaySubscription(
  purchaseToken: string,
  productId: string,
): Promise<GoogleSubscriptionPurchaseV2> {
  const token = await getGooglePlayAccessToken();
  if (!token) {
    throw HttpError.badRequest(
      'Server-side Google Play billing is not configured',
      'play_billing_not_configured',
    );
  }

  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    env.googlePlay.packageName,
  )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn(
      { status: res.status, productId, body: body.slice(0, 500) },
      'Google Play subscriptions.get failed',
    );
    if (res.status === 404 || res.status === 410) {
      throw HttpError.badRequest('Purchase token not found', 'purchase_not_found');
    }
    throw HttpError.badRequest('Could not verify purchase with Google Play', 'play_verify_failed');
  }

  return (await res.json()) as GoogleSubscriptionPurchaseV2;
}

function pickLineItem(
  purchase: GoogleSubscriptionPurchaseV2,
  requestedProductId: string,
): GoogleSubscriptionLineItem {
  const items = purchase.lineItems ?? [];
  const matching = items.find((i) => i.productId === requestedProductId);
  const item = matching ?? items[0];
  if (!item) {
    throw HttpError.badRequest('Subscription has no line items', 'play_no_line_items');
  }
  return item;
}

/**
 * Verifies a Google Play subscription purchase, upserts the local Subscription row,
 * and refreshes the user's `premiumUntil` cache. Idempotent — safe to call repeatedly
 * (e.g. on app launch).
 */
export async function verifyGooglePlayPurchase(
  userId: string,
  input: { productId: string; purchaseToken: string },
) {
  if (!env.googlePlay.premiumProductIds.includes(input.productId)) {
    throw HttpError.badRequest('Unknown premium product', 'unknown_product');
  }

  const purchase = await fetchGooglePlaySubscription(input.purchaseToken, input.productId);
  const line = pickLineItem(purchase, input.productId);
  const productId = line.productId;
  const expiryTime = line.expiryTime ? new Date(line.expiryTime) : null;
  if (!expiryTime) {
    throw HttpError.badRequest('Subscription has no expiry time', 'play_no_expiry');
  }

  const status: SubscriptionStatus = purchase.subscriptionState
    ? STATE_MAP[purchase.subscriptionState] ?? 'expired'
    : 'active';

  const autoRenewing = !!line.autoRenewingPlan?.autoRenewEnabled;

  // Don't let the same purchaseToken get bound to two different users.
  const existing = await prisma.subscription.findUnique({
    where: {
      platform_purchaseToken: {
        platform: 'google_play',
        purchaseToken: input.purchaseToken,
      },
    },
  });
  if (existing && existing.userId !== userId) {
    throw HttpError.conflict('Purchase already bound to another account', 'purchase_owned_elsewhere');
  }

  const rawPayload = purchase as unknown as Prisma.InputJsonValue;

  const subscription = await prisma.subscription.upsert({
    where: {
      platform_purchaseToken: {
        platform: 'google_play',
        purchaseToken: input.purchaseToken,
      },
    },
    create: {
      userId,
      platform: 'google_play',
      productId,
      purchaseToken: input.purchaseToken,
      originalOrderId: purchase.latestOrderId ?? null,
      status,
      autoRenewing,
      startedAt: purchase.startTime ? new Date(purchase.startTime) : new Date(),
      currentPeriodEnd: expiryTime,
      canceledAt: status === 'canceled' ? new Date() : null,
      rawPayload,
    },
    update: {
      productId,
      originalOrderId: purchase.latestOrderId ?? undefined,
      status,
      autoRenewing,
      currentPeriodEnd: expiryTime,
      canceledAt: status === 'canceled' ? new Date() : null,
      rawPayload,
      lastVerifiedAt: new Date(),
    },
  });

  await syncPremiumUntil(userId);

  void track('subscription_verified', userId, {
    platform: 'google_play',
    productId,
    status,
    autoRenewing,
    expiresAt: expiryTime.toISOString(),
  });

  return {
    id: subscription.id,
    productId: subscription.productId,
    status: subscription.status,
    autoRenewing: subscription.autoRenewing,
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    isEntitling: isEntitlingStatus(subscription.status),
  };
}

/**
 * Re-checks every active subscription for a user. Cheap — usually 0-1 row per user.
 * Called by cron + on-demand by /billing/me when stale.
 */
export async function refreshUserSubscriptions(userId: string): Promise<void> {
  const subs = await prisma.subscription.findMany({
    where: { userId, platform: 'google_play' },
  });
  for (const sub of subs) {
    try {
      await verifyGooglePlayPurchase(userId, {
        productId: sub.productId,
        purchaseToken: sub.purchaseToken,
      });
    } catch (err) {
      logger.warn({ err, userId, subId: sub.id }, 'subscription refresh failed');
    }
  }
}

/**
 * Manually grant N days of premium to a user — used by:
 *   - admin actions (comp time, support credits)
 *   - referral rewards
 * Creates a synthetic "manual" subscription row and bumps premiumUntil.
 */
export async function grantManualPremium(
  userId: string,
  days: number,
  reason: string,
): Promise<Date> {
  if (days <= 0) throw HttpError.badRequest('Days must be > 0', 'invalid_days');

  const now = new Date();
  const baseline = await getCurrentPremiumUntil(userId);
  const start = baseline && baseline > now ? baseline : now;
  const newEnd = new Date(start.getTime() + days * 24 * 60 * 60_000);

  await prisma.subscription.create({
    data: {
      userId,
      platform: 'manual',
      productId: `manual.${reason}`,
      purchaseToken: `manual:${userId}:${now.getTime()}`,
      status: 'active',
      autoRenewing: false,
      startedAt: now,
      currentPeriodEnd: newEnd,
      rawPayload: { reason, days, grantedAt: now.toISOString() },
    },
  });

  await syncPremiumUntil(userId);
  void track('premium_granted', userId, { reason, days });
  return newEnd;
}

async function getCurrentPremiumUntil(userId: string): Promise<Date | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { premiumUntil: true },
  });
  return user?.premiumUntil ?? null;
}

export async function listMySubscriptions(userId: string) {
  const subs = await prisma.subscription.findMany({
    where: { userId },
    orderBy: { currentPeriodEnd: 'desc' },
  });
  return subs.map((s) => ({
    id: s.id,
    platform: s.platform,
    productId: s.productId,
    status: s.status,
    autoRenewing: s.autoRenewing,
    currentPeriodEnd: s.currentPeriodEnd.toISOString(),
    isEntitling: isEntitlingStatus(s.status),
  }));
}
