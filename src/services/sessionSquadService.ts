import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { getBlockedUserIds } from './blockService';
import { sendPush } from './pushService';
import { emitToUser } from '../socket';
import { TX_OPTIONS } from '../config/prismaTx';

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

export async function listSquadCandidates(userId: string, gameId: string): Promise<SquadCandidate[]> {
  const blocked = await getBlockedUserIds(userId);
  const exclude = new Set([userId, ...blocked]);
  const onlineThreshold = Date.now() - ONLINE_MS;

  const recent = await prisma.recentPlayer.findMany({
    where: {
      ownerId: userId,
      gameId,
      playerUserId: { notIn: [...exclude] },
    },
    orderBy: { lastPlayedAt: 'desc' },
    take: 30,
    include: {
      player: { select: { id: true, name: true, photoUrl: true, lastSeenAt: true } },
    },
  });

  const byUserId = new Map<string, SquadCandidate>();

  for (const r of recent) {
    byUserId.set(r.playerUserId, {
      userId: r.playerUserId,
      name: r.player.name,
      photoUrl: r.photoUrl ?? r.player.photoUrl,
      nickname: r.nickname,
      isOnline: (r.player.lastSeenAt?.getTime() ?? 0) > onlineThreshold,
      source: 'recent',
    });
  }

  const profiles = await prisma.userGameProfile.findMany({
    where: {
      gameId,
      userId: { notIn: [...exclude, ...byUserId.keys()] },
    },
    take: 40,
    include: {
      user: { select: { id: true, name: true, photoUrl: true, lastSeenAt: true } },
    },
  });

  for (const p of profiles) {
    const isOnline = (p.user.lastSeenAt?.getTime() ?? 0) > onlineThreshold;
    if (!isOnline && byUserId.size >= 20) continue;
    byUserId.set(p.userId, {
      userId: p.userId,
      name: p.user.name,
      photoUrl: p.user.photoUrl,
      nickname: p.nickname,
      isOnline,
      source: 'suggestion',
    });
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

  await prisma.$transaction(async (tx) => {
    await tx.sessionSquadInvite.update({
      where: { id: inviteId },
      data: { status: 'accepted' },
    });

    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw HttpError.notFound('User not found');

    const session = await tx.session.findUnique({ where: { id: sessionId } });
    if (!session) throw HttpError.notFound('Session not found');

    const profile = await tx.userGameProfile.findUnique({
      where: { userId_gameId: { userId, gameId: session.gameId } },
    });
    if (!profile) {
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
    }
  }, TX_OPTIONS);

  return { ok: true, sessionId };
}
