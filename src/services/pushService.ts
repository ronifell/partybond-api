import { prisma } from '../config/database';
import { getFirebaseAdmin } from '../config/firebase';
import { logger } from '../utils/logger';

const COOLDOWN_MS = 60_000; // 1 push per minute per user
const lastSentAt = new Map<string, number>();

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Send a push notification to a user via FCM. Respects:
 *  - 1/min cooldown (blueprint section 13)
 *  - removes invalid token automatically
 *  - no-ops gracefully if Firebase is not configured (dev environments)
 */
export async function sendPush(userId: string, payload: PushPayload): Promise<boolean> {
  const fb = getFirebaseAdmin();
  if (!fb) return false;

  const now = Date.now();
  const last = lastSentAt.get(userId) ?? 0;
  if (now - last < COOLDOWN_MS) return false;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fcmToken: true },
  });
  if (!user?.fcmToken) return false;

  try {
    await fb.messaging().send({
      token: user.fcmToken,
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    lastSentAt.set(userId, now);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      await prisma.user.update({ where: { id: userId }, data: { fcmToken: null } });
      logger.info({ userId }, 'Removed invalid FCM token');
    } else {
      logger.warn({ err, userId }, 'FCM send failed');
    }
    return false;
  }
}
