import { Prisma } from '@prisma/client';

import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export type AnalyticsEventName =
  | 'login'
  | 'register'
  | 'onboarding_complete'
  | 'game_selected'
  | 'session_created'
  | 'session_enter'
  | 'queue_join'
  | 'queue_leave'
  | 'match_start'
  | 'interaction_sent'
  | 'match_end'
  | 'match_timeout'
  | 'group_created'
  | 'group_invite_sent'
  | 'group_invite_accepted'
  | 'group_invite_declined'
  | 'user_blocked'
  | 'user_reported';

export async function track(
  name: AnalyticsEventName,
  userId: string | null,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.analyticsEvent.create({
      data: {
        name,
        userId: userId ?? null,
        payload: payload !== undefined ? (payload as Prisma.InputJsonObject) : undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, name }, 'Failed to record analytics event');
  }
}
