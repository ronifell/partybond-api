import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { track } from './analyticsService';
import { emitMatchCreated } from './matchNotifyService';
import { recordRecentPlayersFromMatch } from './recentPlayerService';
import { TX_OPTIONS } from '../config/prismaTx';

const MATCH_TTL_MIN = 15;

type Tx = Prisma.TransactionClient;

/**
 * Try to pair two waiting users in a session into a Match.
 * Returns the match if created, or null if not enough players.
 *
 * Enforces the BLUEPRINT v3.3 transaction:
 *   1. lock & get 2 users
 *   2. validate state == in_queue
 *   3. create match
 *   4. remove from queue
 *   5. update users to in_match
 */
export async function tryCreateMatchForSession(sessionId: string) {
  const result = await prisma.$transaction(async (tx: Tx) => {
    // Lock 2 oldest queue entries for this session. SELECT ... FOR UPDATE SKIP LOCKED
    // ensures two concurrent matchmakers won't grab the same row.
    const entries = await tx.$queryRaw<Array<{ id: string; user_id: string }>>`
      SELECT id, user_id FROM "queue_entries"
      WHERE session_id = ${sessionId}
      ORDER BY joined_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 2
    `;
    if (entries.length < 2) return null;

    const [a, b] = entries;

    // Validate user states
    const users = await tx.user.findMany({
      where: { id: { in: [a.user_id, b.user_id] } },
      select: { id: true, state: true },
    });
    if (users.length < 2 || users.some((u) => u.state !== 'in_queue')) {
      // bail out — let later attempts retry
      return null;
    }

    const session = await tx.session.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true },
    });
    if (!session) return null;

    // Create match
    const match = await tx.match.create({
      data: {
        sessionId,
        userAId: a.user_id,
        userBId: b.user_id,
        expiresAt: new Date(Date.now() + MATCH_TTL_MIN * 60_000),
      },
    });

    // Remove from queue
    await tx.queueEntry.deleteMany({
      where: { id: { in: [a.id, b.id] } },
    });

    // Promote users -> in_match
    await tx.user.updateMany({
      where: { id: { in: [a.user_id, b.user_id] } },
      data: {
        state: 'in_match',
        currentMatchId: match.id,
        currentSessionId: sessionId,
      },
    });

    // Activate session if still open
    if (session.status === 'open') {
      await tx.session.update({
        where: { id: sessionId },
        data: { status: 'active' },
      });
    }

    return match;
  }, TX_OPTIONS);

  if (result) {
    await emitMatchCreated(result.id);
    void track('match_start', result.userAId, { matchId: result.id });
    void track('match_start', result.userBId, { matchId: result.id });
  }

  return result;
}

/**
 * Triggered after a user joins the queue. Keeps trying to pair until no more
 * matches can be created in this session.
 */
export async function tryDrainSession(sessionId: string): Promise<void> {
  try {
    // Loop until no more matches can be created
    // (handles multiple people joining a session in quick succession).
    // Cap at a safety limit.
    for (let i = 0; i < 32; i += 1) {
      const match = await tryCreateMatchForSession(sessionId);
      if (!match) return;
    }
  } catch (err) {
    logger.error({ err, sessionId }, 'tryDrainSession failed');
  }
}

/**
 * End a match (manual completion or expiry).
 */
export async function endMatch(matchId: string, reason: 'finished' | 'expired') {
  const result = await prisma.$transaction(async (tx: Tx) => {
    const match = await tx.match.findUnique({
      where: { id: matchId },
      include: { session: { select: { gameId: true } } },
    });
    if (!match) throw HttpError.notFound('Match not found');
    if (match.status !== 'active') return { updated: match, recordRecent: false as const };

    const updated = await tx.match.update({
      where: { id: matchId },
      data: { status: reason, endedAt: new Date() },
    });

    await tx.user.updateMany({
      where: { id: { in: [match.userAId, match.userBId] } },
      data: { state: 'idle', currentMatchId: null, currentSessionId: null },
    });

    return {
      updated,
      recordRecent: {
        userAId: match.userAId,
        userBId: match.userBId,
        gameId: match.session.gameId,
      },
    };
  }, TX_OPTIONS);

  if (result.recordRecent) {
    void recordRecentPlayersFromMatch(
      result.recordRecent.userAId,
      result.recordRecent.userBId,
      result.recordRecent.gameId,
    );
  }
  return result.updated;
}
