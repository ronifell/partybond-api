import { PrismaClient, GameStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const games = [
    { id: 'free_fire', name: 'Free Fire', status: GameStatus.active, maxPlayers: 4 },
    {
      id: 'elden_ring_nightreign',
      name: 'Elden Ring Nightreign',
      status: GameStatus.active,
      maxPlayers: 3,
    },
    { id: 'valorant', name: 'Valorant', status: GameStatus.active, maxPlayers: 5 },
    { id: 'cod_mobile', name: 'Call of Duty', status: GameStatus.active, maxPlayers: 5 },
    {
      id: 'league_of_legends',
      name: 'League of Legends',
      status: GameStatus.active,
      maxPlayers: 5,
    },
    { id: 'fortnite', name: 'Fortnite', status: GameStatus.active, maxPlayers: 4 },
    {
      id: 'counter_strike_2',
      name: 'Counter-Strike 2',
      status: GameStatus.active,
      maxPlayers: 5,
    },
    {
      id: 'ea_sports_fc_26',
      name: 'EA Sports FC 26',
      status: GameStatus.active,
      maxPlayers: 4,
    },
    { id: 'minecraft', name: 'Minecraft', status: GameStatus.active, maxPlayers: 4 },
    { id: 'roblox', name: 'Roblox', status: GameStatus.active, maxPlayers: 4 },
    { id: 'pubg_mobile', name: 'PUBG Mobile', status: GameStatus.coming_soon, maxPlayers: 4 },
    {
      id: 'mobile_legends',
      name: 'Mobile Legends',
      status: GameStatus.coming_soon,
      maxPlayers: 5,
    },
    // Fallback catalog row for free-text Squad Rescue games that do not match.
    // Hidden from the mobile catalog (coming_soon + filtered in GET /games).
    { id: 'custom', name: 'Custom', status: GameStatus.coming_soon, maxPlayers: 8 },
  ];

  for (const g of games) {
    await prisma.game.upsert({
      where: { id: g.id },
      update: { name: g.name, status: g.status, maxPlayers: g.maxPlayers },
      create: g,
    });
  }

  await prisma.community.upsert({
    where: { id: 'ffmobilebrasil' },
    update: { name: 'FF Mobile Brasil' },
    create: { id: 'ffmobilebrasil', name: 'FF Mobile Brasil' },
  });

  console.log('Seed completed: games + default community inserted/updated.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
