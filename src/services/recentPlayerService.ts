import { prisma } from '../config/database';
import { getBlockedUserIds } from './blockService';

const MAX_RECENT = 100;

export async function recordRecentPlayersFromMatch(
  userAId: string,
  userBId: string,
  gameId: string,
): Promise<void> {
  const playedAt = new Date();
  const profiles = await prisma.userGameProfile.findMany({
    where: { userId: { in: [userAId, userBId] }, gameId },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: [userAId, userBId] } },
    select: { id: true, photoUrl: true },
  });
  const profileMap = new Map(profiles.map((p) => [p.userId, p]));
  const userMap = new Map(users.map((u) => [u.id, u]));

  const pairs: Array<{ ownerId: string; playerUserId: string }> = [
    { ownerId: userAId, playerUserId: userBId },
    { ownerId: userBId, playerUserId: userAId },
  ];

  for (const { ownerId, playerUserId } of pairs) {
    const prof = profileMap.get(playerUserId);
    const u = userMap.get(playerUserId);
    if (!prof || !u) continue;

    await prisma.recentPlayer.upsert({
      where: {
        ownerId_playerUserId_gameId: { ownerId, playerUserId, gameId },
      },
      create: {
        ownerId,
        playerUserId,
        gameId,
        nickname: prof.nickname,
        photoUrl: u.photoUrl,
        platform: prof.platform,
        lastPlayedAt: playedAt,
      },
      update: {
        nickname: prof.nickname,
        photoUrl: u.photoUrl,
        platform: prof.platform,
        lastPlayedAt: playedAt,
      },
    });

    const count = await prisma.recentPlayer.count({ where: { ownerId } });
    if (count > MAX_RECENT) {
      const oldest = await prisma.recentPlayer.findMany({
        where: { ownerId },
        orderBy: { lastPlayedAt: 'asc' },
        take: count - MAX_RECENT,
        select: { id: true },
      });
      await prisma.recentPlayer.deleteMany({
        where: { id: { in: oldest.map((o) => o.id) } },
      });
    }
  }
}

export async function listRecentPlayers(ownerId: string) {
  const blocked = await getBlockedUserIds(ownerId);
  const rows = await prisma.recentPlayer.findMany({
    where: {
      ownerId,
      playerUserId: blocked.size ? { notIn: [...blocked] } : undefined,
    },
    orderBy: { lastPlayedAt: 'desc' },
    take: MAX_RECENT,
    include: {
      game: { select: { id: true, name: true } },
      player: { select: { id: true, name: true, photoUrl: true, lastSeenAt: true } },
    },
  });

  const onlineThreshold = Date.now() - 5 * 60_000;
  return rows.map((r) => ({
    id: r.id,
    userId: r.playerUserId,
    nickname: r.nickname,
    photoUrl: r.photoUrl ?? r.player.photoUrl,
    gameId: r.gameId,
    gameName: r.game.name,
    platform: r.platform,
    lastPlayedAt: r.lastPlayedAt.toISOString(),
    isOnline: (r.player.lastSeenAt?.getTime() ?? 0) > onlineThreshold,
  }));
}
