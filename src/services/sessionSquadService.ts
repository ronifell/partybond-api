import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { getBlockedUserIds } from './blockService';
import { sendPush } from './pushService';
import { emitToUser, emitToSession } from '../socket';
import { TX_OPTIONS } from '../config/prismaTx';
import { tryDrainSession } from './matchmakingService';
import { track } from './analyticsService';
import { isRealAppUser } from '../utils/realAppUser';

const ONLINE_MS = 5 * 60_000;
const INVITE_TTL_MS = 24 * 60 * 60_000;

export type SquadCandidate = {
  userId: string;
  name: string;
  photoUrl: string | null;
  nickname: string | null;
  isOnline: boolean;
  source: 'recent' | 'suggestion';
};

/**
 * Players you can invite to a squad: real users from your recent-player history
 * for this game (and online recent contacts who also have this game profile).
 * Does not scan the whole user table.
 */
export async function listSquadCandidates(userId: string, gameId: string): Promise<SquadCandidate[]> {
  const blocked = await getBlockedUserIds(userId);
  const exclude = new Set([userId, ...blocked]);
  const onlineThreshold = new Date(Date.now() - ONLINE_MS);

  const recentRows = await prisma.recentPlayer.findMany({
    where: {
      ownerId: userId,
      playerUserId: { notIn: [...exclude] },
    },
    orderBy: { lastPlayedAt: 'desc' },
    take: 100,
    include: {
      player: {
        select: { id: true, name: true, email: true, photoUrl: true, lastSeenAt: true },
      },
    },
  });

  const profilesForGame = await prisma.userGameProfile.findMany({
    where: {
      gameId,
      userId: {
        in: recentRows.map((r) => r.playerUserId).filter((id) => !exclude.has(id)),
      },
    },
    select: { userId: true, nickname: true },
  });
  const nicknameByUser = new Map(profilesForGame.map((p) => [p.userId, p.nickname]));

  const byUserId = new Map<string, SquadCandidate>();

  for (const r of recentRows) {
    if (!isRealAppUser(r.player.email)) continue;

    const hasThisGameProfile = nicknameByUser.has(r.playerUserId) || r.gameId === gameId;
    if (!hasThisGameProfile) continue;

    const isOnline = (r.player.lastSeenAt?.getTime() ?? 0) > onlineThreshold.getTime();
    const nickname = nicknameByUser.get(r.playerUserId) ?? (r.gameId === gameId ? r.nickname : null);

    const existing = byUserId.get(r.playerUserId);
    const source: SquadCandidate['source'] = r.gameId === gameId ? 'recent' : 'suggestion';

    if (!existing) {
      byUserId.set(r.playerUserId, {
        userId: r.playerUserId,
        name: r.player.name,
        photoUrl: r.photoUrl ?? r.player.photoUrl,
        nickname,
        isOnline,
        source,
      });
      continue;
    }

    if (r.gameId === gameId) {
      existing.source = 'recent';
      existing.nickname = nickname ?? existing.nickname;
    }
    if (isOnline) existing.isOnline = true;
  }

  return [...byUserId.values()].sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    if (a.source !== b.source) return a.source === 'recent' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function sendSessionSquadInvites(
  sessionId: string,
  inviterId: string,
  inviteeIds: string[],
) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { game: { select: { name: true } } },
  });
  if (!session) throw HttpError.notFound('Session not found');
  if (session.createdById !== inviterId) {
    throw HttpError.forbidden('Only the squad leader can send invites');
  }

  const blocked = await getBlockedUserIds(inviterId);
  const inviter = await prisma.user.findUnique({
    where: { id: inviterId },
    select: { name: true },
  });

  const unique = [...new Set(inviteeIds)].filter(
    (id) => id !== inviterId && !blocked.has(id),
  );

  const created: string[] = [];
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  for (const inviteeId of unique) {
    const invite = await prisma.sessionSquadInvite.upsert({
      where: { sessionId_inviteeId: { sessionId, inviteeId } },
      create: {
        sessionId,
        inviterId,
        inviteeId,
        expiresAt,
        status: 'pending',
      },
      update: {
        status: 'pending',
        inviterId,
        expiresAt,
      },
    });
    created.push(invite.id);

    const payload = {
      inviteId: invite.id,
      sessionId,
      gameId: session.gameId,
      gameName: session.game.name,
      sessionTitle: session.title,
      inviter: { id: inviterId, name: inviter?.name ?? 'Player' },
    };

    emitToUser(inviteeId, 'session:squad-invite', payload);

    void sendPush(
      inviteeId,
      {
        title: 'Squad invite',
        body: `${inviter?.name ?? 'Someone'} invited you to their squad for ${session.game.name}`,
        data: { type: 'session_squad_invite', inviteId: invite.id, sessionId },
      },
      'squad_fill_invite',
    );
  }

  return { inviteIds: created, count: created.length };
}

export async function listPendingSessionSquadInvites(inviteeId: string) {
  const now = new Date();
  const rows = await prisma.sessionSquadInvite.findMany({
    where: {
      inviteeId,
      status: 'pending',
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      session: { include: { game: { select: { id: true, name: true } } } },
      inviter: { select: { id: true, name: true, photoUrl: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    expiresAt: r.expiresAt.toISOString(),
    inviter: r.inviter,
    session: {
      id: r.session.id,
      title: r.session.title,
      gameId: r.session.gameId,
      gameName: r.session.game.name,
    },
  }));
}

export async function respondSessionSquadInvite(
  inviteId: string,
  userId: string,
  accept: boolean,
) {
  const invite = await prisma.sessionSquadInvite.findUnique({
    where: { id: inviteId },
    include: { session: true },
  });
  if (!invite || invite.inviteeId !== userId) throw HttpError.notFound('Invite not found');
  if (invite.status !== 'pending') throw HttpError.badRequest('Already handled');
  if (invite.expiresAt.getTime() < Date.now()) {
    await prisma.sessionSquadInvite.update({
      where: { id: inviteId },
      data: { status: 'expired' },
    });
    throw HttpError.badRequest('Invite expired', 'invite_expired');
  }

  if (!accept) {
    await prisma.sessionSquadInvite.update({
      where: { id: inviteId },
      data: { status: 'declined' },
    });
    return { ok: true, sessionId: invite.sessionId };
  }

  const sessionId = invite.sessionId;
  let joinedQueue = false;

  await prisma.$transaction(async (tx) => {
    await tx.sessionSquadInvite.update({
      where: { id: inviteId },
      data: { status: 'accepted' },
    });

    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw HttpError.notFound('User not found');

    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw HttpError.notFound('Session not found');
    if (session.status === 'finished') {
      throw HttpError.badRequest('Session finished', 'session_finished');
    }

    const profile = await tx.userGameProfile.findUnique({
      where: { userId_gameId: { userId, gameId: session.gameId } },
    });
    if (!profile?.nickname?.trim() || !profile?.playerId?.trim()) {
      throw HttpError.badRequest('Set your game profile first', 'no_game_profile');
    }

    if (user.state === 'idle') {
      await tx.queueEntry.upsert({
        where: { sessionId_userId: { sessionId, userId } },
        create: { sessionId, userId },
        update: {},
      });
      await tx.user.update({
        where: { id: userId },
        data: { state: 'in_queue', currentSessionId: sessionId, currentMatchId: null },
      });
      joinedQueue = true;
    } else if (user.state === 'in_queue' && user.currentSessionId === sessionId) {
      joinedQueue = true;
    }
  }, TX_OPTIONS);

  let waitingCount: number | undefined;
  if (joinedQueue) {
    void track('queue_join', userId, { sessionId, source: 'squad_invite_accept' });
    waitingCount = await prisma.queueEntry.count({ where: { sessionId } });
    emitToSession(sessionId, 'queue:update', { sessionId, waitingCount });
    await tryDrainSession(sessionId);
  }

  return { ok: true, sessionId, joinedQueue, waitingCount };
}
