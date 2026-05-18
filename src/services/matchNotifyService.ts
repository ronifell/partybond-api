import { prisma } from '../config/database';
import { emitToUser, emitToSession } from '../socket';
import { sendPush } from './pushService';

/** Emit sockets + push after a match is committed. */
export async function emitMatchCreated(matchId: string): Promise<void> {
  const matchFull = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      userA: { include: { gameProfiles: true } },
      userB: { include: { gameProfiles: true } },
      session: true,
    },
  });
  if (!matchFull) return;

  const game = matchFull.session.gameId;
  const profileFor = (u: typeof matchFull.userA) =>
    u.gameProfiles.find((p) => p.gameId === game) ?? null;

  const payloadForA = {
    matchId: matchFull.id,
    sessionId: matchFull.sessionId,
    gameId: game,
    opponent: {
      id: matchFull.userB.id,
      name: matchFull.userB.name,
      photoUrl: matchFull.userB.photoUrl,
      nickname: profileFor(matchFull.userB)?.nickname ?? null,
      playerId: profileFor(matchFull.userB)?.playerId ?? null,
      lookingFor: matchFull.userB.lookingFor ?? null,
    },
    expiresAt: matchFull.expiresAt.toISOString(),
  };
  const payloadForB = {
    matchId: matchFull.id,
    sessionId: matchFull.sessionId,
    gameId: game,
    opponent: {
      id: matchFull.userA.id,
      name: matchFull.userA.name,
      photoUrl: matchFull.userA.photoUrl,
      nickname: profileFor(matchFull.userA)?.nickname ?? null,
      playerId: profileFor(matchFull.userA)?.playerId ?? null,
      lookingFor: matchFull.userA.lookingFor ?? null,
    },
    expiresAt: matchFull.expiresAt.toISOString(),
  };

  emitToUser(matchFull.userAId, 'match:created', payloadForA);
  emitToUser(matchFull.userBId, 'match:created', payloadForB);
  emitToSession(matchFull.sessionId, 'session:match', { matchId: matchFull.id });

  void Promise.allSettled([
    sendPush(
      matchFull.userAId,
      {
        title: 'Match found!',
        body: `You were paired with ${matchFull.userB.name}.`,
        data: { type: 'match_start', matchId: matchFull.id },
      },
      'match_found',
    ),
    sendPush(
      matchFull.userBId,
      {
        title: 'Match found!',
        body: `You were paired with ${matchFull.userA.name}.`,
        data: { type: 'match_start', matchId: matchFull.id },
      },
      'match_found',
    ),
  ]);
}
