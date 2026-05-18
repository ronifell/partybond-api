import type { PlayStyle, Prisma, SessionMode } from '@prisma/client';
import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { track } from './analyticsService';
import { emitMatchCreated } from './matchNotifyService';
import { getBlockedUserIds } from './blockService';
import { TX_OPTIONS } from '../config/prismaTx';

const MATCH_TTL_MIN = 15;
const PHASE1_MS = 25_000;
const PHASE2_MS = 30_000;

type Tx = Prisma.TransactionClient;

export function getQueuePhase(joinedAt: Date): 1 | 2 | 3 {
  const waited = Date.now() - joinedAt.getTime();
  if (waited <= PHASE1_MS) return 1;
  if (waited <= PHASE2_MS) return 2;
  return 3;
}

function areCompatible(
  a: { gameId: string; gameMode: SessionMode; playStyle: PlayStyle; joinedAt: Date },
  b: { gameId: string; gameMode: SessionMode; playStyle: PlayStyle; joinedAt: Date },
): boolean {
  if (a.gameId !== b.gameId) return false;
  const phase = Math.max(getQueuePhase(a.joinedAt), getQueuePhase(b.joinedAt)) as 1 | 2 | 3;
  if (phase === 1) return a.gameMode === b.gameMode && a.playStyle === b.playStyle;
  if (phase === 2) return a.gameMode === b.gameMode;
  return true;
}

export async function joinGlobalQueue(
  userId: string,
  input: { gameId: string; gameMode: SessionMode; playStyle: PlayStyle },
) {
  const game = await prisma.game.findUnique({ where: { id: input.gameId } });
  if (!game || game.status !== 'active') {
    throw HttpError.badRequest('Game not active', 'game_inactive');
  }

  const profile = await prisma.userGameProfile.findUnique({
    where: { userId_gameId: { userId, gameId: input.gameId } },
  });
  if (!profile) throw HttpError.badRequest('Set your game profile first', 'no_game_profile');

  await prisma.$transaction(async (tx: Tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw HttpError.notFound('User not found');
    if (user.state !== 'idle') {
      throw HttpError.conflict(`User is ${user.state}`, 'invalid_state');
    }

    await tx.globalQueueEntry.upsert({
      where: { userId },
      create: {
        userId,
        gameId: input.gameId,
        gameMode: input.gameMode,
        playStyle: input.playStyle,
      },
      update: {
        gameId: input.gameId,
        gameMode: input.gameMode,
        playStyle: input.playStyle,
        joinedAt: new Date(),
      },
    });

    await tx.user.update({
      where: { id: userId },
      data: { state: 'in_queue', currentSessionId: null, currentMatchId: null },
    });
  }, TX_OPTIONS);

  void track('queue_join', userId, { gameId: input.gameId, progressive: true });
  await tryMatchGlobalQueue(input.gameId);
}

export async function leaveGlobalQueue(userId: string) {
  await prisma.$transaction(async (tx: Tx) => {
    await tx.globalQueueEntry.deleteMany({ where: { userId } });
    await tx.user.updateMany({
      where: { id: userId, state: 'in_queue' },
      data: { state: 'idle', currentSessionId: null, currentMatchId: null },
    });
  }, TX_OPTIONS);
  void track('queue_leave', userId, { progressive: true });
}

export async function getGlobalQueueStatus(userId: string) {
  const entry = await prisma.globalQueueEntry.findUnique({ where: { userId } });
  if (!entry) return null;
  const waitedSeconds = Math.floor((Date.now() - entry.joinedAt.getTime()) / 1000);
  return {
    gameId: entry.gameId,
    gameMode: entry.gameMode,
    playStyle: entry.playStyle,
    phase: getQueuePhase(entry.joinedAt),
    waitedSeconds,
    joinedAt: entry.joinedAt.toISOString(),
  };
}

export async function tryMatchGlobalQueue(gameId: string): Promise<void> {
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const created = await tryCreateProgressiveMatch(gameId);
      if (!created) break;
    }
  } catch (err) {
    logger.error({ err, gameId }, 'tryMatchGlobalQueue failed');
  }
}

async function tryCreateProgressiveMatch(gameId: string): Promise<boolean> {
  const entries = await prisma.globalQueueEntry.findMany({
    where: { gameId },
    orderBy: { joinedAt: 'asc' },
  });
  if (entries.length < 2) return false;

  const blockedCache = new Map<string, Set<string>>();

  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i]!;
    if (!blockedCache.has(a.userId)) {
      blockedCache.set(a.userId, await getBlockedUserIds(a.userId));
    }
    const blockedA = blockedCache.get(a.userId)!;

    for (let j = i + 1; j < entries.length; j += 1) {
      const b = entries[j]!;
      if (blockedA.has(b.userId)) continue;
      if (!areCompatible(a, b)) continue;

      const matchId = await prisma.$transaction(async (tx: Tx) => {
        const entryA = await tx.globalQueueEntry.findUnique({ where: { userId: a.userId } });
        const entryB = await tx.globalQueueEntry.findUnique({ where: { userId: b.userId } });
        if (!entryA || !entryB || entryA.gameId !== gameId || entryB.gameId !== gameId) {
          return null;
        }

        const users = await tx.user.findMany({
          where: { id: { in: [a.userId, b.userId] } },
          select: { id: true, state: true },
        });
        if (users.length < 2 || users.some((u) => u.state !== 'in_queue')) return null;

        const session = await tx.session.create({
          data: {
            gameId,
            title: 'Quick Match',
            createdById: a.userId,
            gameMode: a.gameMode,
            playStyle: a.playStyle,
            playersNeeded: 2,
            scheduledAt: new Date(),
            status: 'active',
          },
        });

        const match = await tx.match.create({
          data: {
            sessionId: session.id,
            userAId: a.userId,
            userBId: b.userId,
            expiresAt: new Date(Date.now() + MATCH_TTL_MIN * 60_000),
          },
        });

        await tx.globalQueueEntry.deleteMany({
          where: { userId: { in: [a.userId, b.userId] } },
        });
        await tx.queueEntry.deleteMany({
          where: { userId: { in: [a.userId, b.userId] } },
        });

        await tx.user.updateMany({
          where: { id: { in: [a.userId, b.userId] } },
          data: {
            state: 'in_match',
            currentMatchId: match.id,
            currentSessionId: session.id,
          },
        });

        const phase = Math.max(getQueuePhase(a.joinedAt), getQueuePhase(b.joinedAt));
        void track('match_start', a.userId, { matchId: match.id, phase });
        void track('match_start', b.userId, { matchId: match.id, phase });

        return match.id;
      }, TX_OPTIONS);

      if (matchId) {
        await emitMatchCreated(matchId);
        return true;
      }
    }
  }
  return false;
}
