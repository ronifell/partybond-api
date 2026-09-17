import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Prisma, SquadRescueStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { TX_OPTIONS } from '../config/prismaTx';
import {
  CUSTOM_GAME_ID,
  GAME_ALIASES,
  RESCUE_CODE_ALPHABET,
  RESCUE_CODE_LENGTH,
  SQUAD_RESCUE_TTL_MS,
  isRescueMatchType,
  isRescueMicPreference,
  isRescuePlatform,
  sessionModeFromMatchType,
  type RescueMatchType,
  type RescueMicPreference,
  type RescuePlatform,
} from '../constants/squadRescue';
import { HttpError } from '../utils/httpError';
import {
  assertCommunityUrl,
  communityPlatformFromUrl,
  slugFromName,
} from '../utils/communityUrl';
import { signGuestJwt } from '../utils/jwt';
import { track } from './analyticsService';
import { emitRescueMembers, emitRescueUpdate } from '../socket';

const GUEST_HASH_ROUNDS = 8;

type Tx = Prisma.TransactionClient;

export interface RescueMemberDto {
  nickname: string;
  gameUid: string;
  hasMic: boolean;
  isCreator: boolean;
}

export interface RescueCommunityDto {
  id: string;
  name: string;
  platform: 'discord' | 'facebook';
  externalUrl: string | null;
}

export interface RescuePublicDto {
  code: string;
  sessionId: string;
  game: string;
  gameId: string;
  platform: RescuePlatform;
  matchType: RescueMatchType;
  gameMode: string | null;
  micPreference: RescueMicPreference;
  micRequired: boolean;
  extrasNeeded: number;
  current: number;
  total: number;
  openSlots: number;
  status: SquadRescueStatus;
  expiresAt: string;
  createdAt: string;
  community: RescueCommunityDto | null;
}

export interface RescueMemberViewDto extends RescuePublicDto {
  role: 'creator' | 'member';
  you: RescueMemberDto;
  members: RescueMemberDto[];
  shareUrl: string;
}

const sessionInclude = {
  rescueMembers: { orderBy: { joinedAt: 'asc' as const } },
  rescueCommunity: true,
  game: true,
} satisfies Prisma.SessionInclude;

type RescueSession = Prisma.SessionGetPayload<{ include: typeof sessionInclude }>;

function generateRescueCode(): string {
  let out = '';
  const bytes = crypto.randomBytes(RESCUE_CODE_LENGTH);
  for (let i = 0; i < RESCUE_CODE_LENGTH; i += 1) {
    out += RESCUE_CODE_ALPHABET[bytes[i]! % RESCUE_CODE_ALPHABET.length];
  }
  return out;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeUid(value: string): string {
  return value.trim().toLowerCase();
}

function shareUrl(code: string): string {
  return `${env.webAppUrl}/s/${code}`;
}

function activeMembers<T extends { leftAt: Date | null }>(session: { rescueMembers: T[] }): T[] {
  return session.rescueMembers.filter((m) => !m.leftAt);
}

export async function resolveGameId(gameLabel: string): Promise<string> {
  const normalized = normalizeLabel(gameLabel);
  const alias = GAME_ALIASES[normalized];
  if (alias) {
    const byAlias = await prisma.game.findUnique({ where: { id: alias } });
    if (byAlias) return byAlias.id;
  }

  const games = await prisma.game.findMany({
    where: { id: { not: CUSTOM_GAME_ID } },
    select: { id: true, name: true },
  });
  const byId = games.find((g) => g.id === normalized.replace(/\s+/g, '_'));
  if (byId) return byId.id;
  const byName = games.find((g) => normalizeLabel(g.name) === normalized);
  if (byName) return byName.id;
  return CUSTOM_GAME_ID;
}

async function ensureCustomGame(tx: Tx): Promise<void> {
  await tx.game.upsert({
    where: { id: CUSTOM_GAME_ID },
    update: {},
    create: { id: CUSTOM_GAME_ID, name: 'Custom', status: 'coming_soon', maxPlayers: 8 },
  });
}

function rescuePlatformOf(session: RescueSession): RescuePlatform {
  return isRescuePlatform(session.rescuePlatform) ? session.rescuePlatform : 'mobile';
}

function rescueMatchTypeOf(session: RescueSession): RescueMatchType {
  if (isRescueMatchType(session.rescueMatchType)) return session.rescueMatchType;
  return session.gameMode === 'competitive' ? 'ranked' : 'casual';
}

function rescueMicPreferenceOf(session: RescueSession): RescueMicPreference {
  if (isRescueMicPreference(session.rescueMicPreference)) return session.rescueMicPreference;
  if (session.rescueMicRequired === true) return 'yes';
  if (session.rescueMicRequired === false) return 'no';
  return 'any';
}

function toPublicCommunity(community: NonNullable<RescueSession['rescueCommunity']>): RescueCommunityDto {
  return {
    id: community.id,
    name: community.name,
    platform: community.platform === 'facebook' ? 'facebook' : 'discord',
    externalUrl: community.externalUrl,
  };
}

function toPublic(session: RescueSession): RescuePublicDto {
  const members = activeMembers(session);
  const total = session.playersNeeded;
  const current = members.length;
  const status = session.rescueStatus ?? 'expired';
  const openSlots = status === 'open' ? Math.max(0, total - current) : 0;
  const micPreference = rescueMicPreferenceOf(session);
  const modeLabel = session.rescueGameMode?.trim() || null;
  return {
    code: session.rescueCode!,
    sessionId: session.id,
    game: session.rescueGameLabel || session.game.name,
    gameId: session.gameId,
    platform: rescuePlatformOf(session),
    matchType: rescueMatchTypeOf(session),
    gameMode: modeLabel,
    micPreference,
    micRequired: micPreference === 'yes',
    extrasNeeded: Math.max(0, total - 1),
    current,
    total,
    openSlots,
    status,
    expiresAt: (session.rescueExpiresAt ?? session.createdAt).toISOString(),
    createdAt: session.createdAt.toISOString(),
    community: session.rescueCommunity ? toPublicCommunity(session.rescueCommunity) : null,
  };
}

function toMemberView(session: RescueSession, userId: string): RescueMemberViewDto {
  const mine = session.rescueMembers.find((m) => m.userId === userId && !m.leftAt);
  if (!mine) {
    throw HttpError.forbidden('Not a member of this squad', 'not_member');
  }
  return {
    ...toPublic(session),
    role: mine.isCreator ? 'creator' : 'member',
    you: {
      nickname: mine.nickname,
      gameUid: mine.gameUid,
      hasMic: mine.hasMic,
      isCreator: mine.isCreator,
    },
    members: activeMembers(session).map((m) => ({
      nickname: m.nickname,
      gameUid: m.gameUid,
      hasMic: m.hasMic,
      isCreator: m.isCreator,
    })),
    shareUrl: shareUrl(session.rescueCode!),
  };
}

function emitRescue(session: RescueSession): void {
  const code = session.rescueCode;
  if (!code) return;
  const pub = toPublic(session);
  emitRescueUpdate(code, pub);
  emitRescueMembers(code, {
    ...pub,
    members: activeMembers(session).map((m) => ({
      nickname: m.nickname,
      gameUid: m.gameUid,
      hasMic: m.hasMic,
      isCreator: m.isCreator,
    })),
  });
}

async function loadByCode(tx: Tx | typeof prisma, code: string): Promise<RescueSession | null> {
  return tx.session.findUnique({
    where: { rescueCode: code.toUpperCase() },
    include: sessionInclude,
  });
}

async function lockByCode(tx: Tx, code: string): Promise<RescueSession> {
  const upper = code.toUpperCase();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sessions WHERE rescue_code = ${upper} FOR UPDATE
  `;
  if (rows.length === 0) throw HttpError.notFound('Squad Rescue not found', 'not_found');
  const session = await tx.session.findUnique({
    where: { id: rows[0]!.id },
    include: sessionInclude,
  });
  if (!session?.rescueCode) throw HttpError.notFound('Squad Rescue not found', 'not_found');
  return session;
}

async function expireIfNeeded(tx: Tx, session: RescueSession): Promise<RescueSession> {
  if (session.rescueStatus !== 'open') return session;
  if (!session.rescueExpiresAt || session.rescueExpiresAt.getTime() > Date.now()) return session;

  const updated = await tx.session.update({
    where: { id: session.id },
    data: {
      rescueStatus: 'expired',
      rescueClosedAt: new Date(),
      status: 'finished',
    },
    include: sessionInclude,
  });
  void track('rescue_expired', session.createdById, { sessionId: session.id, code: session.rescueCode });
  return updated;
}

function assertOpen(session: RescueSession): void {
  if (session.rescueStatus === 'open') return;
  const code =
    session.rescueStatus === 'expired'
      ? 'squad_expired'
      : session.rescueStatus === 'completed'
        ? 'squad_full'
        : 'squad_closed';
  throw HttpError.badRequest('This Squad Rescue is no longer open', code);
}

function isPrismaUniqueConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export async function ensureGuest(input: {
  guestKey: string;
  locale?: string;
}): Promise<{ token: string; user: { id: string; name: string } }> {
  const guestKey = input.guestKey.trim();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(guestKey)) {
    throw HttpError.badRequest('Invalid guest key', 'invalid_guest_key');
  }

  const locale = input.locale === 'pt' ? 'pt' : 'en';
  const email = `guest.${guestKey.toLowerCase()}@guest.partybond.internal`;

  let user =
    (await prisma.user.findUnique({ where: { guestKey } })) ??
    (await prisma.user.findUnique({ where: { email } }));

  if (user?.bannedAt) {
    throw HttpError.forbidden('This guest cannot join', 'banned');
  }

  if (!user) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), GUEST_HASH_ROUNDS);
    try {
      user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name: 'Guest',
          age: 18,
          locale,
          isGuest: true,
          guestKey,
        },
      });
    } catch (err) {
      if (!isPrismaUniqueConflict(err)) throw err;
      user =
        (await prisma.user.findUnique({ where: { guestKey } })) ??
        (await prisma.user.findUnique({ where: { email } }));
      if (!user) throw err;
    }
  }

  if (user.locale !== locale || user.guestKey !== guestKey) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        locale,
        guestKey,
      },
    });
  }

  const token = signGuestJwt({ sub: user.id, email: user.email });
  return { token, user: { id: user.id, name: user.name } };
}

async function uniqueCode(tx: Tx): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const code = generateRescueCode();
    const exists = await tx.session.findUnique({ where: { rescueCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  throw HttpError.badRequest('Could not allocate a squad code', 'code_alloc_failed');
}

export async function createRescue(
  userId: string,
  input: {
    game: string;
    platform: RescuePlatform;
    matchType: RescueMatchType;
    gameMode?: string;
    extrasNeeded: number;
    nickname: string;
    gameUid: string;
    micPreference: RescueMicPreference;
    communityId?: string;
  },
): Promise<RescueMemberViewDto> {
  const gameLabel = input.game.trim();
  const nickname = input.nickname.trim();
  const gameUid = input.gameUid.trim();
  const extrasNeeded = input.extrasNeeded;
  const total = extrasNeeded + 1;
  const gameId = await resolveGameId(gameLabel);
  const modeLabel = input.gameMode?.trim() || null;
  const micRequired = input.micPreference === 'yes';

  const communityId = input.communityId?.trim().toLowerCase();
  const community = communityId
    ? await prisma.community.findUnique({ where: { id: communityId } })
    : null;
  if (communityId && !community) {
    throw HttpError.notFound('Community not found', 'community_not_found');
  }

  const session = await prisma.$transaction(async (tx) => {
    await ensureCustomGame(tx);
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw HttpError.notFound('User not found');
    if (user.bannedAt) throw HttpError.forbidden('Account banned', 'banned');

    const code = await uniqueCode(tx);
    const now = new Date();
    const created = await tx.session.create({
      data: {
        gameId,
        title: `Squad Rescue — ${gameLabel}`.slice(0, 60),
        createdById: userId,
        gameMode: sessionModeFromMatchType(input.matchType),
        skillTier: 'beginner',
        playersNeeded: total,
        scheduledAt: now,
        status: 'open',
        rescueCode: code,
        rescueStatus: 'open',
        rescuePlatform: input.platform,
        rescueMicRequired: micRequired,
        rescueGameLabel: gameLabel.slice(0, 80),
        rescueMatchType: input.matchType,
        rescueGameMode: modeLabel ? modeLabel.slice(0, 60) : null,
        rescueMicPreference: input.micPreference,
        rescueExpiresAt: new Date(now.getTime() + SQUAD_RESCUE_TTL_MS),
        rescueCommunityId: community?.id ?? null,
        rescueMembers: {
          create: {
            userId,
            nickname,
            gameUid,
            hasMic: input.micPreference !== 'no',
            isCreator: true,
          },
        },
      },
      include: sessionInclude,
    });

    await tx.user.update({
      where: { id: userId },
      data: { name: nickname },
    });

    if (gameId !== CUSTOM_GAME_ID) {
      await tx.userGameProfile.upsert({
        where: { userId_gameId: { userId, gameId } },
        create: {
          userId,
          gameId,
          nickname,
          playerId: gameUid,
          platform: input.platform,
        },
        update: { nickname, playerId: gameUid, platform: input.platform },
      });
    }

    if (community) {
      await tx.community.update({
        where: { id: community.id },
        data: { squadsCreated: { increment: 1 } },
      });
    }

    return created;
  }, TX_OPTIONS);

  void track('rescue_created', userId, {
    sessionId: session.id,
    code: session.rescueCode,
    game: gameLabel,
    communityId: community?.id ?? null,
  });
  emitRescue(session);
  return toMemberView(session, userId);
}

export async function getPublicRescue(code: string): Promise<RescuePublicDto> {
  const loaded = await prisma.$transaction(async (tx) => {
    const session = await loadByCode(tx, code);
    if (!session) throw HttpError.notFound('Squad Rescue not found', 'not_found');
    return expireIfNeeded(tx, session);
  }, TX_OPTIONS);
  if (loaded.rescueStatus === 'expired') emitRescue(loaded);
  return toPublic(loaded);
}

export async function getMemberRescue(code: string, userId: string): Promise<RescueMemberViewDto> {
  const loaded = await prisma.$transaction(async (tx) => {
    const session = await loadByCode(tx, code);
    if (!session) throw HttpError.notFound('Squad Rescue not found', 'not_found');
    return expireIfNeeded(tx, session);
  }, TX_OPTIONS);
  return toMemberView(loaded, userId);
}

export async function joinRescue(
  code: string,
  userId: string,
  input: { nickname: string; gameUid: string; hasMic: boolean; confirmGameId: boolean },
): Promise<RescueMemberViewDto> {
  if (!input.confirmGameId) {
    throw HttpError.badRequest('Confirm the Game ID before joining', 'confirm_required');
  }
  const nickname = input.nickname.trim();
  const gameUid = input.gameUid.trim();

  const session = await prisma.$transaction(async (tx) => {
    let current = await expireIfNeeded(tx, await lockByCode(tx, code));
    assertOpen(current);

    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw HttpError.notFound('User not found');
    if (user.bannedAt) throw HttpError.forbidden('Account banned', 'banned');

    const seated = activeMembers(current);
    const existing = current.rescueMembers.find((m) => m.userId === userId);

    if (existing && !existing.leftAt) {
      return current;
    }

    if (seated.some((m) => normalizeUid(m.gameUid) === normalizeUid(gameUid) && m.userId !== userId)) {
      throw HttpError.conflict('This Game ID is already in the squad', 'duplicate_uid');
    }

    if (seated.length >= current.playersNeeded) {
      throw HttpError.conflict('This squad is full', 'squad_full');
    }

    if (existing && existing.leftAt) {
      await tx.squadRescueMember.update({
        where: { id: existing.id },
        data: { leftAt: null, nickname, gameUid, hasMic: input.hasMic, joinedAt: new Date() },
      });
    } else {
      await tx.squadRescueMember.create({
        data: {
          sessionId: current.id,
          userId,
          nickname,
          gameUid,
          hasMic: input.hasMic,
          isCreator: false,
        },
      });
    }

    await tx.user.update({ where: { id: userId }, data: { name: nickname } });

    if (current.gameId !== CUSTOM_GAME_ID) {
      await tx.userGameProfile.upsert({
        where: { userId_gameId: { userId, gameId: current.gameId } },
        create: {
          userId,
          gameId: current.gameId,
          nickname,
          playerId: gameUid,
          platform: current.rescuePlatform ?? undefined,
        },
        update: { nickname, playerId: gameUid },
      });
    }

    const after = await tx.session.findUniqueOrThrow({
      where: { id: current.id },
      include: sessionInclude,
    });
    const nextCount = activeMembers(after).length;
    if (nextCount >= after.playersNeeded) {
      const completed = await tx.session.update({
        where: { id: after.id },
        data: {
          rescueStatus: 'completed',
          rescueClosedAt: new Date(),
          status: 'finished',
        },
        include: sessionInclude,
      });
      if (completed.rescueCommunityId) {
        await tx.community.update({
          where: { id: completed.rescueCommunityId },
          data: { squadsCompleted: { increment: 1 } },
        });
      }
      void track('rescue_completed', userId, { sessionId: completed.id, code: completed.rescueCode });
      return completed;
    }
    return after;
  }, TX_OPTIONS);

  void track('rescue_joined', userId, { sessionId: session.id, code: session.rescueCode });
  emitRescue(session);
  return toMemberView(session, userId);
}

export async function leaveRescue(code: string, userId: string): Promise<RescuePublicDto> {
  const session = await prisma.$transaction(async (tx) => {
    let current = await expireIfNeeded(tx, await lockByCode(tx, code));
    assertOpen(current);

    const mine = current.rescueMembers.find((m) => m.userId === userId && !m.leftAt);
    if (!mine) throw HttpError.badRequest('You are not in this squad', 'not_member');
    if (mine.isCreator) {
      throw HttpError.badRequest('The creator cannot leave. End the squad instead.', 'creator_cannot_leave');
    }

    await tx.squadRescueMember.update({
      where: { id: mine.id },
      data: { leftAt: new Date() },
    });

    return tx.session.findUniqueOrThrow({
      where: { id: current.id },
      include: sessionInclude,
    });
  }, TX_OPTIONS);

  void track('rescue_left', userId, { sessionId: session.id, code: session.rescueCode });
  emitRescue(session);
  return toPublic(session);
}

export async function endRescue(code: string, userId: string): Promise<RescueMemberViewDto> {
  const session = await prisma.$transaction(async (tx) => {
    let current = await expireIfNeeded(tx, await lockByCode(tx, code));
    const creator = current.rescueMembers.find((m) => m.isCreator);
    if (!creator || creator.userId !== userId) {
      throw HttpError.forbidden('Only the creator can end this squad', 'not_creator');
    }
    if (current.rescueStatus !== 'open') return current;

    return tx.session.update({
      where: { id: current.id },
      data: {
        rescueStatus: 'cancelled',
        rescueClosedAt: new Date(),
        status: 'finished',
      },
      include: sessionInclude,
    });
  }, TX_OPTIONS);

  void track('rescue_ended', userId, { sessionId: session.id, code: session.rescueCode });
  emitRescue(session);
  return toMemberView(session, userId);
}

export async function playAgain(code: string, userId: string): Promise<RescueMemberViewDto> {
  const previous = await loadByCode(prisma, code);
  if (!previous) throw HttpError.notFound('Squad Rescue not found', 'not_found');
  const mine = previous.rescueMembers.find((m) => m.userId === userId);
  if (!mine) throw HttpError.forbidden('Not a member of this squad', 'not_member');

  const created = await createRescue(userId, {
    game: previous.rescueGameLabel || previous.game.name,
    platform: rescuePlatformOf(previous),
    matchType: rescueMatchTypeOf(previous),
    gameMode: previous.rescueGameMode ?? undefined,
    extrasNeeded: Math.max(1, previous.playersNeeded - 1),
    nickname: mine.nickname,
    gameUid: mine.gameUid,
    micPreference: rescueMicPreferenceOf(previous),
    communityId: previous.rescueCommunityId ?? undefined,
  });
  void track('rescue_play_again', userId, { from: previous.rescueCode, to: created.code });
  return created;
}

export async function expireOpenRescues(): Promise<number> {
  const stale = await prisma.session.findMany({
    where: { rescueStatus: 'open', rescueExpiresAt: { lte: new Date() } },
    select: { rescueCode: true },
  });
  let count = 0;
  for (const row of stale) {
    if (!row.rescueCode) continue;
    try {
      const expired = await prisma.$transaction(async (tx) => {
        const session = await expireIfNeeded(tx, await lockByCode(tx, row.rescueCode!));
        return session;
      }, TX_OPTIONS);
      emitRescue(expired);
      count += 1;
    } catch {
      // Another worker may have closed it.
    }
  }
  return count;
}

export async function getCommunity(slug: string): Promise<RescueCommunityDto> {
  const community = await prisma.community.findUnique({
    where: { id: slug.trim().toLowerCase() },
  });
  if (!community) throw HttpError.notFound('Community not found', 'community_not_found');
  return toPublicCommunity(community);
}

export async function recordCommunityVisit(slug: string): Promise<RescueCommunityDto> {
  const community = await prisma.community
    .update({
      where: { id: slug.trim().toLowerCase() },
      data: { visitCount: { increment: 1 } },
    })
    .catch(() => null);
  if (!community) throw HttpError.notFound('Community not found', 'community_not_found');
  return toPublicCommunity(community);
}

function setupKeyMatches(provided: string): boolean {
  const expected = env.communitySetupKey;
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function communitySetupUrl(): string | null {
  if (!env.communitySetupKey) return null;
  return `${env.webAppUrl}/setup/${env.communitySetupKey}`;
}

export async function setupCommunity(input: {
  key: string;
  name: string;
  externalUrl: string;
  id?: string;
}): Promise<{ community: RescueCommunityDto; publicUrl: string }> {
  if (!setupKeyMatches(input.key)) {
    throw HttpError.unauthorized('Invalid setup link', 'invalid_setup_key');
  }
  const platform = communityPlatformFromUrl(input.externalUrl);
  if (!platform) {
    throw HttpError.badRequest('Use a Discord or Facebook link', 'invalid_community_url');
  }
  const externalUrl = assertCommunityUrl(platform, input.externalUrl);
  const id = (input.id?.trim().toLowerCase() || slugFromName(input.name));
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(id)) {
    throw HttpError.badRequest('Choose a simple community link (letters and numbers)', 'invalid_slug');
  }
  const exists = await prisma.community.findUnique({ where: { id } });
  if (exists) throw HttpError.conflict('This community link is already taken', 'slug_taken');
  const created = await prisma.community.create({
    data: {
      id,
      name: input.name.trim(),
      platform,
      externalUrl,
    },
  });
  return {
    community: toPublicCommunity(created),
    publicUrl: `${env.webAppUrl}/c/${created.id}`,
  };
}

