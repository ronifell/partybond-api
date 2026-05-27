import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { emitToUser } from '../socket';
import { sendPush } from './pushService';

function nextOccurrence(dayOfWeek: number, timeLocal: string, from: Date): Date {
  const [hh, mm] = timeLocal.split(':').map(Number);
  const d = new Date(from);
  d.setHours(hh ?? 21, mm ?? 0, 0, 0);
  const diff = (dayOfWeek - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 && d <= from ? 7 : diff));
  if (diff === 0 && d <= from) d.setDate(d.getDate() + 7);
  return d;
}

export async function createGroupSchedule(
  groupId: string,
  userId: string,
  input: {
    dayOfWeek: number;
    timeLocal: string;
    frequency?: 'weekly' | 'biweekly';
    timezone?: string;
    startsAt?: string;
  },
) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { createdById: true },
  });
  if (!group) throw HttpError.notFound('Group not found');
  if (group.createdById !== userId) {
    throw HttpError.forbidden('Only the group creator can schedule sessions', 'creator_required');
  }

  const existingUpcoming = await prisma.groupSession.findFirst({
    where: { groupId, startsAt: { gte: new Date() } },
    orderBy: { startsAt: 'asc' },
  });
  if (existingUpcoming) {
    throw HttpError.conflict(
      'A weekly session is already scheduled for this group',
      'session_already_scheduled',
    );
  }

  const schedule = await prisma.groupSchedule.create({
    data: {
      groupId,
      dayOfWeek: input.dayOfWeek,
      timeLocal: input.timeLocal,
      frequency: input.frequency ?? 'weekly',
      timezone: input.timezone ?? 'America/Sao_Paulo',
    },
  });

  const startsAt = input.startsAt
    ? new Date(input.startsAt)
    : nextOccurrence(schedule.dayOfWeek, schedule.timeLocal, new Date());
  if (Number.isNaN(startsAt.getTime()) || startsAt <= new Date()) {
    throw HttpError.badRequest('Invalid start date/time', 'invalid_starts_at');
  }
  const session = await prisma.groupSession.create({
    data: { groupId, scheduleId: schedule.id, startsAt },
  });

  const members = await prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
  await prisma.groupSessionRsvp.createMany({
    data: members.map((m) => ({ sessionId: session.id, userId: m.userId, status: 'pending' })),
    skipDuplicates: true,
  });

  return { schedule, nextSession: session };
}

export async function setRsvp(sessionId: string, userId: string, status: 'confirmed' | 'declined') {
  const session = await prisma.groupSession.findUnique({
    where: { id: sessionId },
    include: { group: { select: { id: true, name: true } } },
  });
  if (!session) throw HttpError.notFound('Session not found');

  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: session.groupId, userId } },
    include: { user: { select: { name: true } } },
  });
  if (!member) throw HttpError.forbidden('Not a group member');

  await prisma.groupSessionRsvp.upsert({
    where: { sessionId_userId: { sessionId, userId } },
    create: { sessionId, userId, status },
    update: { status },
  });

  const members = await prisma.groupMember.findMany({
    where: { groupId: session.groupId },
    select: { userId: true },
  });

  const payload = {
    groupId: session.groupId,
    groupName: session.group.name,
    sessionId,
    userId,
    userName: member.user.name,
    status,
  };

  for (const m of members) {
    emitToUser(m.userId, 'group:session-rsvp', payload);
  }
}

export async function sendSessionReminders(): Promise<void> {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60_000);
  const in30m = new Date(now.getTime() + 30 * 60_000);
  const windowMs = 5 * 60_000;

  const sessions = await prisma.groupSession.findMany({
    where: { startsAt: { gte: now, lte: new Date(now.getTime() + 25 * 60 * 60_000) } },
    include: { group: true, rsvps: { where: { status: 'confirmed' } } },
  });

  for (const s of sessions) {
    const t = s.startsAt.getTime();
    const is24h = Math.abs(t - in24h.getTime()) < windowMs;
    const is30m = Math.abs(t - in30m.getTime()) < windowMs;
    if (!is24h && !is30m) continue;

    const members = await prisma.groupMember.findMany({
      where: { groupId: s.groupId },
      select: { userId: true },
    });
    const label = is24h ? '24 hours' : '30 minutes';
    for (const m of members) {
      void sendPush(
        m.userId,
        {
          title: 'Upcoming squad session',
          body: `${s.group.name} starts in ${label}`,
          data: { type: 'group_session_reminder', sessionId: s.id, groupId: s.groupId },
        },
        'session_reminder',
      );
    }
  }
}
