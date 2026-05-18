import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { sendPush } from './pushService';
import { isBlockedEitherWay } from './blockService';
import { track } from './analyticsService';

const INVITE_TTL_DAYS = 7;

async function assertGroupAdmin(groupId: string, userId: string) {
  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!member || member.role !== 'admin') {
    throw HttpError.forbidden('Admin only', 'admin_required');
  }
}

async function assertGroupMember(groupId: string, userId: string) {
  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!member) throw HttpError.forbidden('Not a group member', 'not_member');
}

export async function createGroup(userId: string, name: string, memberIds: string[] = []) {
  const uniqueMembers = [...new Set(memberIds.filter((id) => id !== userId))];

  const group = await prisma.$transaction(async (tx) => {
    const g = await tx.group.create({
      data: { name, createdById: userId },
    });
    await tx.groupMember.create({
      data: { groupId: g.id, userId, role: 'admin' },
    });
    const conv = await tx.conversation.create({
      data: { type: 'group', groupId: g.id },
    });
    await tx.conversationParticipant.create({
      data: { conversationId: conv.id, userId },
    });
    for (const mid of uniqueMembers) {
      if (await isBlockedEitherWay(userId, mid)) continue;
      await tx.groupMember.create({
        data: { groupId: g.id, userId: mid, role: 'member' },
      });
      await tx.conversationParticipant.create({
        data: { conversationId: conv.id, userId: mid },
      });
    }
    return g;
  });

  void track('group_created', userId, { groupId: group.id });
  return getGroupDetail(group.id, userId);
}

export async function listGroups(userId: string) {
  const memberships = await prisma.groupMember.findMany({
    where: { userId },
    include: {
      group: {
        include: {
          members: {
            include: { user: { select: { id: true, name: true, photoUrl: true } } },
          },
          _count: { select: { members: true } },
        },
      },
    },
    orderBy: { joinedAt: 'desc' },
  });
  return memberships.map((m) => ({
    id: m.group.id,
    name: m.group.name,
    photoUrl: m.group.photoUrl,
    memberCount: m.group._count.members,
    members: m.group.members.map((mb) => ({
      id: mb.user.id,
      name: mb.user.name,
      photoUrl: mb.user.photoUrl,
      role: mb.role,
    })),
    createdAt: m.group.createdAt.toISOString(),
  }));
}

export async function getGroupDetail(groupId: string, userId: string) {
  await assertGroupMember(groupId, userId);
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, photoUrl: true, lastSeenAt: true } } },
      },
      schedules: true,
      sessions: {
        where: { startsAt: { gte: new Date() } },
        orderBy: { startsAt: 'asc' },
        take: 1,
        include: { rsvps: true },
      },
      conversation: { select: { id: true } },
    },
  });
  if (!group) throw HttpError.notFound('Group not found');

  const nextSession = group.sessions[0];
  const onlineThreshold = Date.now() - 5 * 60_000;

  return {
    id: group.id,
    name: group.name,
    photoUrl: group.photoUrl,
    createdById: group.createdById,
    createdAt: group.createdAt.toISOString(),
    conversationId: group.conversation?.id ?? null,
    members: group.members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      photoUrl: m.user.photoUrl,
      role: m.role,
      isOnline: (m.user.lastSeenAt?.getTime() ?? 0) > onlineThreshold,
    })),
    schedules: group.schedules.map((s) => ({
      id: s.id,
      dayOfWeek: s.dayOfWeek,
      timeLocal: s.timeLocal,
      frequency: s.frequency,
      timezone: s.timezone,
    })),
    nextSession: nextSession
      ? {
          id: nextSession.id,
          startsAt: nextSession.startsAt.toISOString(),
          rsvps: nextSession.rsvps.map((r) => ({
            userId: r.userId,
            status: r.status,
          })),
        }
      : null,
  };
}

export async function inviteToGroup(
  groupId: string,
  inviterId: string,
  inviteeId: string,
) {
  await assertGroupAdmin(groupId, inviterId);
  if (inviterId === inviteeId) throw HttpError.badRequest('Cannot invite yourself');

  const existing = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: inviteeId } },
  });
  if (existing) throw HttpError.conflict('Already a member', 'already_member');

  if (await isBlockedEitherWay(inviterId, inviteeId)) {
    throw HttpError.forbidden('Cannot invite this user', 'blocked');
  }

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) throw HttpError.notFound('Group not found');

  const invite = await prisma.groupInvite.create({
    data: {
      groupId,
      inviterId,
      inviteeId,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60_000),
    },
  });

  const inviter = await prisma.user.findUnique({ where: { id: inviterId }, select: { name: true } });
  void sendPush(
    inviteeId,
    {
      title: 'Group invite',
      body: `${inviter?.name ?? 'Someone'} invited you to join ${group.name}`,
      data: { type: 'group_invite', inviteId: invite.id, groupId },
    },
    'group_invite',
  );
  void track('group_invite_sent', inviterId, { groupId, inviteeId });

  return { inviteId: invite.id, status: invite.status };
}

export async function respondGroupInvite(
  inviteId: string,
  userId: string,
  accept: boolean,
) {
  const invite = await prisma.groupInvite.findUnique({
    where: { id: inviteId },
    include: { group: { include: { conversation: true } } },
  });
  if (!invite || invite.inviteeId !== userId) throw HttpError.notFound('Invite not found');
  if (invite.status !== 'pending') throw HttpError.badRequest('Invite already handled');
  if (invite.expiresAt < new Date()) {
    await prisma.groupInvite.update({ where: { id: inviteId }, data: { status: 'expired' } });
    throw HttpError.badRequest('Invite expired', 'invite_expired');
  }

  if (!accept) {
    await prisma.groupInvite.update({
      where: { id: inviteId },
      data: { status: 'declined', respondedAt: new Date() },
    });
    void track('group_invite_declined', userId, { groupId: invite.groupId });
    return { ok: true, status: 'declined' as const };
  }

  await prisma.$transaction(async (tx) => {
    await tx.groupInvite.update({
      where: { id: inviteId },
      data: { status: 'accepted', respondedAt: new Date() },
    });
    await tx.groupMember.create({
      data: { groupId: invite.groupId, userId, role: 'member' },
    });
    if (invite.group.conversation) {
      await tx.conversationParticipant.upsert({
        where: {
          conversationId_userId: {
            conversationId: invite.group.conversation.id,
            userId,
          },
        },
        create: { conversationId: invite.group.conversation.id, userId },
        update: {},
      });
    }
  });

  void track('group_invite_accepted', userId, { groupId: invite.groupId });
  return { ok: true, status: 'accepted' as const, groupId: invite.groupId };
}

export async function removeMember(groupId: string, adminId: string, targetUserId: string) {
  await assertGroupAdmin(groupId, adminId);
  if (adminId === targetUserId) throw HttpError.badRequest('Use leave group instead');
  await prisma.groupMember.deleteMany({ where: { groupId, userId: targetUserId } });
}

export async function leaveGroup(groupId: string, userId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) throw HttpError.notFound('Group not found');
  if (group.createdById === userId) {
    throw HttpError.badRequest('Creator cannot leave; delete group instead', 'creator_cannot_leave');
  }
  await prisma.groupMember.deleteMany({ where: { groupId, userId } });
}

export async function listPendingInvites(userId: string) {
  const invites = await prisma.groupInvite.findMany({
    where: { inviteeId: userId, status: 'pending', expiresAt: { gt: new Date() } },
    include: {
      group: { select: { id: true, name: true, photoUrl: true } },
      inviter: { select: { id: true, name: true, photoUrl: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return invites.map((i) => ({
    id: i.id,
    group: i.group,
    inviter: i.inviter,
    expiresAt: i.expiresAt.toISOString(),
  }));
}
