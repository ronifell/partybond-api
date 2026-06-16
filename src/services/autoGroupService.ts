import type { AutoGroupRequest, PlayStyle, SessionMode, SessionSkillTier } from '@prisma/client';
import { prisma } from '../config/database';
import { HttpError } from '../utils/httpError';
import { logger } from '../utils/logger';
import { track } from './analyticsService';
import { sendPush } from './pushService';
import { getBlockedUserIds } from './blockService';
import { getPremiumStatus } from './premiumService';

const INVITE_TTL_HOURS = 24;
const REQUEST_TTL_MIN = 30;
const MAX_PLAYERS = 16;
const MIN_PLAYERS = 2;

export interface CreateAutoGroupInput {
  name: string;
  gameId: string;
  gameMode: SessionMode;
  playStyle: PlayStyle;
  skillTier: SessionSkillTier;
  playersNeeded: number;
  minAge?: number | null;
  maxAge?: number | null;
}

interface CandidateRow {
  userId: string;
  name: string;
  photoUrl: string | null;
  age: number;
  source: 'global_queue' | 'recent' | 'game_profile';
  priority: number;
}

/**
 * Creates a fresh "auto group" (premium feature). The group exists immediately with
 * only the requester as admin. The matcher then sends invites to candidates ordered by
 * preference fit; invitees must accept to join. The request expires after REQUEST_TTL_MIN.
 *
 * Premium gate is enforced at the controller via `requirePremium`; we double-check here.
 */
export async function startAutoGroup(userId: string, input: CreateAutoGroupInput) {
  if (input.playersNeeded < MIN_PLAYERS || input.playersNeeded > MAX_PLAYERS) {
    throw HttpError.badRequest(
      `playersNeeded must be ${MIN_PLAYERS}-${MAX_PLAYERS}`,
      'invalid_players_needed',
    );
  }

  const premium = await getPremiumStatus(userId);
  if (!premium.isPremium) {
    throw HttpError.forbidden('Premium subscription required', 'premium_required');
  }

  const game = await prisma.game.findUnique({ where: { id: input.gameId } });
  if (!game || game.status !== 'active') {
    throw HttpError.badRequest('Game not active', 'game_inactive');
  }

  // Only one open auto request per user — keep the UI simple.
  const existing = await prisma.autoGroupRequest.findFirst({
    where: { userId, status: 'searching' },
  });
  if (existing) {
    throw HttpError.conflict(
      'You already have a pending auto-group request',
      'auto_group_already_pending',
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const group = await tx.group.create({
      data: {
        name: input.name.trim().slice(0, 60) || 'Auto Squad',
        createdById: userId,
        isAutoFormed: true,
      },
    });
    await tx.groupMember.create({
      data: { groupId: group.id, userId, role: 'admin' },
    });
    const conv = await tx.conversation.create({
      data: { type: 'group', groupId: group.id },
    });
    await tx.conversationParticipant.create({
      data: { conversationId: conv.id, userId },
    });

    const request = await tx.autoGroupRequest.create({
      data: {
        userId,
        groupId: group.id,
        gameId: input.gameId,
        gameMode: input.gameMode,
        playStyle: input.playStyle,
        skillTier: input.skillTier,
        playersNeeded: input.playersNeeded,
        minAge: input.minAge ?? null,
        maxAge: input.maxAge ?? null,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MIN * 60_000),
      },
    });

    return { request, groupId: group.id };
  });

  void track('auto_group_started', userId, {
    gameId: input.gameId,
    playersNeeded: input.playersNeeded,
    gameMode: input.gameMode,
    playStyle: input.playStyle,
  });

  // Fire-and-forget initial invite wave so the request returns fast.
  void runMatchingWave(result.request.id).catch((err) => {
    logger.warn({ err, requestId: result.request.id }, 'initial auto-group wave failed');
  });

  return getAutoGroupStatus(userId, result.request.id);
}

export async function cancelAutoGroup(userId: string, requestId: string) {
  const request = await prisma.autoGroupRequest.findUnique({ where: { id: requestId } });
  if (!request || request.userId !== userId) throw HttpError.notFound('Request not found');
  if (request.status !== 'searching' && request.status !== 'ready') {
    return { ok: true, status: request.status };
  }
  await prisma.autoGroupRequest.update({
    where: { id: requestId },
    data: { status: 'canceled' },
  });
  void track('auto_group_canceled', userId, { requestId });
  return { ok: true, status: 'canceled' as const };
}

export async function getAutoGroupStatus(userId: string, requestId: string) {
  const request = await prisma.autoGroupRequest.findUnique({
    where: { id: requestId },
    include: {
      group: {
        include: {
          members: {
            include: { user: { select: { id: true, name: true, photoUrl: true } } },
          },
          squadFillInvites: {
            where: { status: 'pending' },
            include: { invitee: { select: { id: true, name: true, photoUrl: true } } },
          },
        },
      },
    },
  });
  if (!request || request.userId !== userId) throw HttpError.notFound('Request not found');

  return {
    id: request.id,
    status: request.status,
    groupId: request.groupId,
    gameId: request.gameId,
    gameMode: request.gameMode,
    playStyle: request.playStyle,
    skillTier: request.skillTier,
    playersNeeded: request.playersNeeded,
    expiresAt: request.expiresAt.toISOString(),
    createdAt: request.createdAt.toISOString(),
    confirmedCount: request.group.members.length,
    pendingInvites: request.group.squadFillInvites.map((i) => ({
      id: i.id,
      invitee: i.invitee,
      expiresAt: i.expiresAt.toISOString(),
    })),
    members: request.group.members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      photoUrl: m.user.photoUrl,
      role: m.role,
    })),
  };
}

export async function listMyAutoGroupRequests(userId: string) {
  const requests = await prisma.autoGroupRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      group: { select: { id: true, name: true, _count: { select: { members: true } } } },
    },
  });
  return requests.map((r) => ({
    id: r.id,
    status: r.status,
    groupId: r.groupId,
    groupName: r.group.name,
    confirmedCount: r.group._count.members,
    playersNeeded: r.playersNeeded,
    gameId: r.gameId,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Internal: pick candidates for the request and send pending squad-fill invites.
 *
 * Ordering rules (lower priority = better match):
 *   1. Global-queue user, exact gameMode + playStyle + skillTier match
 *   2. Global-queue user, exact gameMode match
 *   3. Recent player who plays this game
 *   4. User with a profile for this game (game_profile_users)
 *
 * Blocked users + already-invited users + existing members are excluded.
 */
export async function runMatchingWave(requestId: string): Promise<void> {
  const request = await prisma.autoGroupRequest.findUnique({
    where: { id: requestId },
    include: {
      group: {
        include: {
          members: { select: { userId: true } },
          squadFillInvites: { where: { status: 'pending' }, select: { inviteeId: true } },
        },
      },
    },
  });
  if (!request) return;
  if (request.status !== 'searching') return;
  if (request.expiresAt < new Date()) {
    await prisma.autoGroupRequest.update({
      where: { id: requestId },
      data: { status: 'expired' },
    });
    return;
  }

  const confirmedIds = new Set(request.group.members.map((m) => m.userId));
  const pendingIds = new Set(request.group.squadFillInvites.map((i) => i.inviteeId));
  const excludeIds = new Set<string>([...confirmedIds, ...pendingIds]);
  const blocked = await getBlockedUserIds(request.userId);
  for (const id of blocked) excludeIds.add(id);

  const slotsRemaining = request.playersNeeded - confirmedIds.size;
  if (slotsRemaining <= 0) {
    await prisma.autoGroupRequest.update({
      where: { id: requestId },
      data: { status: 'fulfilled' },
    });
    return;
  }

  // Over-invite a little since invitees may decline. Cap at 3x slots or 30 candidates,
  // whichever is smaller — keeps push spam in check.
  const candidatesWanted = Math.min(slotsRemaining * 3, 30);

  const candidates = await pickCandidates(request, excludeIds, candidatesWanted);
  if (candidates.length === 0) {
    logger.info({ requestId }, 'auto-group: no candidates available this wave');
    return;
  }

  const inviter = await prisma.user.findUnique({
    where: { id: request.userId },
    select: { name: true },
  });
  const inviterName = inviter?.name ?? 'A friend';

  for (const c of candidates) {
    try {
      const invite = await prisma.squadFillInvite.create({
        data: {
          groupId: request.groupId,
          inviterId: request.userId,
          inviteeId: c.userId,
          expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60_000),
        },
      });
      void sendPush(
        c.userId,
        {
          title: 'Auto-squad invite',
          body: `${inviterName} is forming a squad — tap to join`,
          data: {
            type: 'auto_group_invite',
            inviteId: invite.id,
            groupId: request.groupId,
            requestId: request.id,
          },
        },
        'squad_fill_invite',
      );
    } catch (err) {
      // Unique constraint on (sessionId, inviteeId) — already invited; skip.
      logger.debug({ err, requestId, userId: c.userId }, 'auto-group invite skipped');
    }
  }
}

async function pickCandidates(
  request: AutoGroupRequest,
  excludeIds: Set<string>,
  limit: number,
): Promise<CandidateRow[]> {
  const candidates: CandidateRow[] = [];
  const ageWhere: { age?: { gte?: number; lte?: number } } = {};
  if (request.minAge != null || request.maxAge != null) {
    ageWhere.age = {};
    if (request.minAge != null) ageWhere.age.gte = request.minAge;
    if (request.maxAge != null) ageWhere.age.lte = request.maxAge;
  }

  // 1) Global queue — best match first.
  const queueEntries = await prisma.globalQueueEntry.findMany({
    where: {
      gameId: request.gameId,
      userId: { notIn: [...excludeIds, request.userId] },
      user: { state: 'in_queue', ...ageWhere },
    },
    include: { user: { select: { id: true, name: true, photoUrl: true, age: true } } },
    take: limit * 2,
  });

  for (const q of queueEntries) {
    const modeOk = q.gameMode === request.gameMode;
    const styleOk = q.playStyle === request.playStyle;
    const priority = modeOk && styleOk ? 1 : modeOk ? 2 : 3;
    candidates.push({
      userId: q.user.id,
      name: q.user.name,
      photoUrl: q.user.photoUrl,
      age: q.user.age,
      source: 'global_queue',
      priority,
    });
    excludeIds.add(q.user.id);
    if (candidates.length >= limit) break;
  }

  // 2) Recent players this requester has played with for this game.
  if (candidates.length < limit) {
    const recent = await prisma.recentPlayer.findMany({
      where: {
        ownerId: request.userId,
        gameId: request.gameId,
        playerUserId: { notIn: [...excludeIds, request.userId] },
        player: ageWhere,
      },
      orderBy: { lastPlayedAt: 'desc' },
      include: { player: { select: { id: true, name: true, photoUrl: true, age: true } } },
      take: limit,
    });
    for (const r of recent) {
      candidates.push({
        userId: r.player.id,
        name: r.player.name,
        photoUrl: r.photoUrl ?? r.player.photoUrl,
        age: r.player.age,
        source: 'recent',
        priority: 4,
      });
      excludeIds.add(r.player.id);
      if (candidates.length >= limit) break;
    }
  }

  // 3) Anyone with a profile for this game (idle users we haven't seen).
  if (candidates.length < limit) {
    const profileUsers = await prisma.userGameProfile.findMany({
      where: {
        gameId: request.gameId,
        userId: { notIn: [...excludeIds, request.userId] },
        user: ageWhere,
      },
      include: { user: { select: { id: true, name: true, photoUrl: true, age: true } } },
      take: limit,
    });
    for (const p of profileUsers) {
      candidates.push({
        userId: p.user.id,
        name: p.user.name,
        photoUrl: p.user.photoUrl,
        age: p.user.age,
        source: 'game_profile',
        priority: 5,
      });
      excludeIds.add(p.user.id);
      if (candidates.length >= limit) break;
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.slice(0, limit);
}

/**
 * Called by groupService after a squad-fill invite is accepted. If this group is an
 * auto-formed one and it now has enough members, flip the request to `fulfilled`.
 * Idempotent.
 */
export async function notifyMemberJoined(groupId: string): Promise<void> {
  const request = await prisma.autoGroupRequest.findUnique({
    where: { groupId },
    include: { group: { include: { _count: { select: { members: true } } } } },
  });
  if (!request) return;
  if (request.status !== 'searching' && request.status !== 'ready') return;

  const count = request.group._count.members;
  if (count >= request.playersNeeded) {
    await prisma.autoGroupRequest.update({
      where: { id: request.id },
      data: { status: 'fulfilled' },
    });
    void track('auto_group_fulfilled', request.userId, {
      requestId: request.id,
      playersNeeded: request.playersNeeded,
    });
    void sendPush(
      request.userId,
      {
        title: 'Your squad is ready!',
        body: `${count}/${request.playersNeeded} players joined.`,
        data: { type: 'auto_group_ready', groupId: request.groupId },
      },
      'squad_fill_invite',
    );
  }
}

/** Cron entrypoint — re-runs matching waves for every still-open request and expires stale ones. */
export async function cronTickAutoGroups(): Promise<void> {
  const now = new Date();
  const open = await prisma.autoGroupRequest.findMany({
    where: { status: 'searching' },
    select: { id: true, expiresAt: true },
  });
  for (const r of open) {
    if (r.expiresAt < now) {
      await prisma.autoGroupRequest.update({
        where: { id: r.id },
        data: { status: 'expired' },
      });
      continue;
    }
    try {
      await runMatchingWave(r.id);
    } catch (err) {
      logger.warn({ err, requestId: r.id }, 'cron auto-group wave failed');
    }
  }
}
