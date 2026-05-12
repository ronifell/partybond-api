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
  | 'match_timeout';

export async function track(
  name: AnalyticsEventName,
  userId: string | null,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.analyticsEvent.create({
      data: { name, userId: userId ?? null, payload: payload ?? undefined },
    });
  } catch (err) {
    logger.warn({ err, name }, 'Failed to record analytics event');
  }
}
