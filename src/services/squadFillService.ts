import type { PlayStyle, SessionMode } from '@prisma/client';
import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { getBlockedUserIds } from './blockService';
import { sendPush } from './pushService';
import { notifyMemberJoined } from './autoGroupService';

type Candidate = {
  userId: string;
  name: string;
  photoUrl: string | null;
  gameMode: SessionMode;
  playStyle: PlayStyle;
  priority: number;
};

export async function getSquadFillSuggestions(groupId: string, requesterId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      members: { select: { userId: true } },
      sessions: {
        where: { startsAt: { gte: new Date() } },
        orderBy: { startsAt: 'asc' },
        take: 1,
        include: { rsvps: true },
      },
    },
  });
  if (!group) throw HttpError.notFound('Group not found');

  const isMember = group.members.some((m) => m.userId === requesterId);
  if (!isMember) throw HttpError.forbidden('Not a member');

  const session = group.sessions[0];
  const game = await prisma.game.findFirst({ where: { status: 'active' } });
  const maxPlayers = game?.maxPlayers ?? 4;
  const confirmed = session?.rsvps.filter((r) => r.status === 'confirmed').length ?? group.members.length;
  const slotsNeeded = Math.max(0, maxPlayers - confirmed);

  const memberIds = new Set(group.members.map((m) => m.userId));
  const blocked = await getBlockedUserIds(requesterId);

  const recent = await prisma.recentPlayer.findMany({
    where: {
      ownerId: requesterId,
      playerUserId: { notIn: [...memberIds, ...blocked, requesterId] },
    },
    orderBy: { lastPlayedAt: 'desc' },
    take: 50,
    include: { player: { select: { id: true, name: true, photoUrl: true } } },
  });

  const queueEntries = await prisma.globalQueueEntry.findMany({
    where: { userId: { notIn: [...memberIds, ...blocked, requesterId] } },
    take: 30,
  });

  const requesterPrefs = await prisma.globalQueueEntry.findUnique({ where: { userId: requesterId } });

  const candidates: Candidate[] = [];

  for (const r of recent) {
    const q = queueEntries.find((e) => e.userId === r.playerUserId);
    const gameMode = q?.gameMode ?? requesterPrefs?.gameMode ?? 'casual';
    const playStyle = q?.playStyle ?? requesterPrefs?.playStyle ?? 'relaxed';
    let priority = 3;
    if (requesterPrefs) {
      if (gameMode === requesterPrefs.gameMode && playStyle === requesterPrefs.playStyle) priority = 1;
      else if (gameMode === requesterPrefs.gameMode) priority = 2;
    }
    candidates.push({
      userId: r.playerUserId,
      name: r.player.name,
      photoUrl: r.photoUrl ?? r.player.photoUrl,
      gameMode,
      playStyle,
      priority,
    });
  }

  candidates.sort((a, b) => a.priority - b.priority);

  return {
    slotsNeeded,
    suggestions: candidates.slice(0, 10).map((c) => ({
      userId: c.userId,
      name: c.name,
      photoUrl: c.photoUrl,
      gameMode: c.gameMode,
      playStyle: c.playStyle,
      priority: c.priority,
    })),
  };
}

export async function inviteSquadFill(
  groupId: string,
  inviterId: string,
  inviteeId: string,
  sessionId?: string,
) {
  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: inviterId } },
  });
  if (!member) throw HttpError.forbidden('Not a member');

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) throw HttpError.notFound('Group not found');

  const invite = await prisma.squadFillInvite.create({
    data: {
      groupId,
      sessionId: sessionId ?? null,
      inviterId,
      inviteeId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  });

  const inviter = await prisma.user.findUnique({ where: { id: inviterId }, select: { name: true } });
  void sendPush(
    inviteeId,
    {
      title: 'Squad fill invite',
      body: `${inviter?.name ?? 'Someone'} invited you to fill a slot in ${group.name}`,
      data: { type: 'squad_fill_invite', inviteId: invite.id, groupId },
    },
    'squad_fill_invite',
  );

  return { inviteId: invite.id };
}

export async function respondSquadFillInvite(inviteId: string, userId: string, accept: boolean) {
  const invite = await prisma.squadFillInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.inviteeId !== userId) throw HttpError.notFound('Invite not found');
  if (invite.status !== 'pending') throw HttpError.badRequest('Already handled');

  if (!accept) {
    await prisma.squadFillInvite.update({ where: { id: inviteId }, data: { status: 'declined' } });
    return { ok: true };
  }

  await prisma.$transaction(async (tx) => {
    await tx.squadFillInvite.update({ where: { id: inviteId }, data: { status: 'accepted' } });
    await tx.groupMember.upsert({
      where: { groupId_userId: { groupId: invite.groupId, userId } },
      create: { groupId: invite.groupId, userId, role: 'member' },
      update: {},
    });
    const conv = await tx.conversation.findUnique({
      where: { groupId: invite.groupId },
      select: { id: true },
    });
    if (conv) {
      await tx.conversationParticipant.upsert({
        where: { conversationId_userId: { conversationId: conv.id, userId } },
        create: { conversationId: conv.id, userId },
        update: {},
      });
    }
    if (invite.sessionId) {
      await tx.groupSessionRsvp.upsert({
        where: { sessionId_userId: { sessionId: invite.sessionId, userId } },
        create: { sessionId: invite.sessionId, userId, status: 'confirmed' },
        update: { status: 'confirmed' },
      });
    }
  });

  // If this group was auto-formed, possibly mark the request as fulfilled.
  void notifyMemberJoined(invite.groupId);

  return { ok: true, groupId: invite.groupId };
}
