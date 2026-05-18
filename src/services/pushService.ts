import { prisma } from '../config/database';
import { getFirebaseAdmin } from '../config/firebase';
import { logger } from '../utils/logger';

/** Cooldown per user per channel so match-found (1/min) does not block teammate quick-action pushes. */
const COOLDOWN_MS: Record<PushChannel, number> = {
  match_found: 60_000,
  interaction: 12_000,
  group_invite: 30_000,
  session_reminder: 60_000,
  squad_fill_invite: 30_000,
};

export type PushChannel =
  | 'match_found'
  | 'interaction'
  | 'group_invite'
  | 'session_reminder'
  | 'squad_fill_invite';

const lastSentAt = new Map<string, number>();

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

function pushKey(userId: string, channel: PushChannel): string {
  return `${userId}:${channel}`;
}

/**
 * Send a push notification to a user via FCM. Respects:
 *  - per-channel cooldown (match_found: 1/min, interaction: 12s — blueprint + teammate signals)
 *  - removes invalid token automatically
 *  - no-ops gracefully if Firebase is not configured (dev environments)
 *
 * Logs every outcome at `info` so you can verify delivery in server logs ("simulate" / trace).
 */
export async function sendPush(
  userId: string,
  payload: PushPayload,
  channel: PushChannel = 'match_found',
): Promise<boolean> {
  const fb = getFirebaseAdmin();
  if (!fb) {
    logger.info({ userId, channel, outcome: 'skipped_no_firebase' }, 'push');
    return false;
  }

  const now = Date.now();
  const key = pushKey(userId, channel);
  const cooldown = COOLDOWN_MS[channel];
  const last = lastSentAt.get(key) ?? 0;
  if (now - last < cooldown) {
    logger.info({ userId, channel, outcome: 'skipped_cooldown', cooldownMs: cooldown, msSinceLast: now - last }, 'push');
    return false;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fcmToken: true },
  });
  if (!user?.fcmToken) {
    logger.info({ userId, channel, outcome: 'skipped_no_token' }, 'push');
    return false;
  }

  try {
    await fb.messaging().send({
      token: user.fcmToken,
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    lastSentAt.set(key, now);
    logger.info({ userId, channel, outcome: 'sent', title: payload.title }, 'push');
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      await prisma.user.update({ where: { id: userId }, data: { fcmToken: null } });
      logger.info({ userId, channel, outcome: 'invalid_token_removed' }, 'push');
    } else {
      logger.warn({ err, userId, channel, outcome: 'fcm_error' }, 'push');
    }
    return false;
  }
}
