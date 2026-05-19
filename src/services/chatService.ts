import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { emitToUser } from '../socket';
import { isBlockedEitherWay } from './blockService';

async function assertParticipant(conversationId: string, userId: string) {
  const p = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!p) throw HttpError.forbidden('Not in conversation', 'not_participant');
}

export async function getOrCreateDirectConversation(userId: string, otherUserId: string) {
  if (userId === otherUserId) throw HttpError.badRequest('Invalid peer');
  if (await isBlockedEitherWay(userId, otherUserId)) {
    throw HttpError.forbidden('Cannot message this user', 'blocked');
  }

  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'direct',
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: otherUserId } } },
      ],
    },
    include: {
      participants: { include: { user: { select: { id: true, name: true, photoUrl: true } } } },
    },
  });

  if (existing && existing.participants.length === 2) {
    return formatConversation(existing, userId);
  }

  const conv = await prisma.conversation.create({
    data: {
      type: 'direct',
      participants: {
        create: [{ userId }, { userId: otherUserId }],
      },
    },
    include: {
      participants: { include: { user: { select: { id: true, name: true, photoUrl: true } } } },
    },
  });
  return formatConversation(conv, userId);
}

function formatConversation(
  conv: {
    id: string;
    type: string;
    groupId: string | null;
    participants: Array<{ user: { id: string; name: string; photoUrl: string | null } }>;
  },
  viewerId: string,
) {
  const others = conv.participants.map((p) => p.user).filter((u) => u.id !== viewerId);
  return {
    id: conv.id,
    type: conv.type,
    groupId: conv.groupId,
    title: conv.type === 'direct' ? (others[0]?.name ?? 'Chat') : undefined,
    peer: conv.type === 'direct' ? others[0] ?? null : null,
    participants: conv.participants.map((p) => p.user),
  };
}

export async function listConversations(userId: string) {
  const parts = await prisma.conversationParticipant.findMany({
    where: { userId },
    include: {
      conversation: {
        include: {
          participants: { include: { user: { select: { id: true, name: true, photoUrl: true } } } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          group: { select: { id: true, name: true, photoUrl: true } },
        },
      },
    },
  });

  const convIds = parts.map((p) => p.conversationId);
  const pinnedRows =
    convIds.length > 0
      ? await prisma.pinnedMessage.findMany({
          where: { conversationId: { in: convIds } },
          select: { conversationId: true },
        })
      : [];
  const pinnedSet = new Set(pinnedRows.map((r) => r.conversationId));

  const rows = await Promise.all(
    parts.map(async (p) => {
      const c = p.conversation;
      const last = c.messages[0];
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: c.id,
          senderId: { not: userId },
          ...(p.lastReadAt ? { createdAt: { gt: p.lastReadAt } } : {}),
        },
      });
      const base = formatConversation(
        {
          id: c.id,
          type: c.type,
          groupId: c.groupId,
          participants: c.participants,
        },
        userId,
      );
      const lastSender = last
        ? c.participants.find((x) => x.user.id === last.senderId)?.user
        : null;
      return {
        ...base,
        title: c.type === 'group' ? (c.group?.name ?? base.title) : base.title,
        photoUrl: c.type === 'group' ? c.group?.photoUrl : base.peer?.photoUrl,
        unreadCount,
        isPinned: pinnedSet.has(c.id),
        lastMessage: last
          ? {
              body: last.body,
              createdAt: last.createdAt.toISOString(),
              senderId: last.senderId,
              senderName: lastSender?.name ?? null,
            }
          : null,
        sortAt: last?.createdAt.toISOString() ?? c.createdAt.toISOString(),
      };
    }),
  );

  rows.sort((a, b) => b.sortAt.localeCompare(a.sortAt));
  return rows.map(({ sortAt: _sortAt, ...rest }) => rest);
}

export async function listMessages(conversationId: string, userId: string, cursor?: string) {
  await assertParticipant(conversationId, userId);
  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      sender: { select: { id: true, name: true, photoUrl: true } },
      replyTo: { select: { id: true, body: true, senderId: true } },
    },
  });

  const pinned = await prisma.pinnedMessage.findMany({
    where: { conversationId },
    include: { message: true },
  });

  return {
    messages: messages.reverse().map((m) => ({
      id: m.id,
      body: m.body,
      senderId: m.senderId,
      sender: m.sender,
      replyToId: m.replyToId,
      replyTo: m.replyTo,
      createdAt: m.createdAt.toISOString(),
    })),
    pinned: pinned.map((p) => ({
      messageId: p.messageId,
      body: p.message.body,
      pinnedAt: p.pinnedAt.toISOString(),
    })),
  };
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  body: string,
  replyToId?: string,
) {
  await assertParticipant(conversationId, senderId);
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 4000) {
    throw HttpError.badRequest('Invalid message body');
  }

  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  });

  for (const p of participants) {
    if (p.userId !== senderId && (await isBlockedEitherWay(senderId, p.userId))) {
      throw HttpError.forbidden('Cannot message this user', 'blocked');
    }
  }

  const message = await prisma.message.create({
    data: { conversationId, senderId, body: trimmed, replyToId },
    include: { sender: { select: { id: true, name: true, photoUrl: true } } },
  });

  const payload = {
    id: message.id,
    conversationId,
    body: message.body,
    senderId: message.senderId,
    sender: message.sender,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
  };

  for (const p of participants) {
    if (p.userId !== senderId) {
      emitToUser(p.userId, 'chat:message', payload);
    }
  }

  return payload;
}

export async function markConversationRead(conversationId: string, userId: string) {
  await assertParticipant(conversationId, userId);
  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: new Date() },
  });
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId, userId: { not: userId } },
    select: { userId: true },
  });
  for (const p of participants) {
    emitToUser(p.userId, 'chat:read', { conversationId, userId, readAt: new Date().toISOString() });
  }
}

export async function pinMessage(conversationId: string, userId: string, messageId: string) {
  await assertParticipant(conversationId, userId);
  const msg = await prisma.message.findFirst({ where: { id: messageId, conversationId } });
  if (!msg) throw HttpError.notFound('Message not found');

  await prisma.pinnedMessage.upsert({
    where: { messageId },
    create: { conversationId, messageId, pinnedById: userId },
    update: { pinnedById: userId, pinnedAt: new Date() },
  });
}

export function emitTyping(conversationId: string, userId: string, isTyping: boolean) {
  void prisma.conversationParticipant
    .findMany({ where: { conversationId, userId: { not: userId } }, select: { userId: true } })
    .then((parts) => {
      for (const p of parts) {
        emitToUser(p.userId, 'chat:typing', { conversationId, userId, isTyping });
      }
    });
}
