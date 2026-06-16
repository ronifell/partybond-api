import cron from 'node-cron';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { endMatch } from './matchmakingService';
import { track } from './analyticsService';
import { tryMatchGlobalQueue } from './progressiveMatchmakingService';
import { sendSessionReminders } from './scheduleService';
import { cronTickAutoGroups } from './autoGroupService';

/** Every minute: expire matches past their TTL. */
async function expireMatches(): Promise<void> {
  const expired = await prisma.match.findMany({
    where: { status: 'active', expiresAt: { lt: new Date() } },
    select: { id: true, userAId: true, userBId: true },
  });
  for (const m of expired) {
    try {
      await endMatch(m.id, 'expired');
      void track('match_timeout', m.userAId, { matchId: m.id });
      void track('match_timeout', m.userBId, { matchId: m.id });
    } catch (err) {
      logger.warn({ err, matchId: m.id }, 'Failed to expire match');
    }
  }
  if (expired.length) logger.info({ count: expired.length }, 'Expired matches');
}

/** Every 5 min: mark scheduled sessions as active (when scheduled_at passes). */
async function activateScheduledSessions(): Promise<void> {
  const res = await prisma.session.updateMany({
    where: { status: 'open', scheduledAt: { lte: new Date() } },
    data: { status: 'active' },
  });
  if (res.count) logger.info({ count: res.count }, 'Activated scheduled sessions');
}

/** Every hour: clear sessions older than 24h. */
async function cleanOldSessions(): Promise<void> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const res = await prisma.session.deleteMany({
    where: { status: 'finished', updatedAt: { lt: dayAgo } },
  });
  if (res.count) logger.info({ count: res.count }, 'Deleted finished sessions');
}

/** Every hour: reset users stuck in inconsistent state. */
async function resetInconsistentUsers(): Promise<void> {
  const fixed = await prisma.$executeRawUnsafe(`
    UPDATE users
    SET state = 'idle', current_match_id = NULL, current_session_id = NULL
    WHERE
      (state = 'in_match' AND (current_match_id IS NULL OR current_match_id NOT IN (SELECT id FROM matches WHERE status = 'active')))
      OR
      (state = 'in_queue' AND current_session_id IS NULL AND id NOT IN (SELECT user_id FROM global_queue_entries))
  `);
  if (fixed) logger.info({ fixed }, 'Reset inconsistent users');
}

/** Every 10s: progressive matchmaking for games with waiters. */
async function runProgressiveMatchmaking(): Promise<void> {
  const entries = await prisma.globalQueueEntry.findMany({ select: { gameId: true } });
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.gameId, (counts.get(e.gameId) ?? 0) + 1);
  }
  for (const [gameId, count] of counts) {
    if (count >= 2) void tryMatchGlobalQueue(gameId);
  }
}

export function startCleanupJobs(): void {
  cron.schedule('* * * * *', () => void expireMatches());
  cron.schedule('*/5 * * * *', () => void activateScheduledSessions());
  cron.schedule('0 * * * *', () => void cleanOldSessions());
  cron.schedule('15 * * * *', () => void resetInconsistentUsers());
  cron.schedule('*/5 * * * *', () => void sendSessionReminders());
  cron.schedule('* * * * *', () => void runProgressiveMatchmaking());
  // Every 30s: re-fan invites for premium auto-group requests and expire stale ones.
  cron.schedule('*/30 * * * * *', () => void cronTickAutoGroups());
  logger.info('Cleanup cron jobs started.');
}
