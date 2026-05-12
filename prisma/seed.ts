import { PrismaClient, GameStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const games = [
    { id: 'free_fire', name: 'Free Fire', status: GameStatus.active, maxPlayers: 4 },
    { id: 'valorant', name: 'Valorant', status: GameStatus.coming_soon, maxPlayers: 5 },
    { id: 'pubg_mobile', name: 'PUBG Mobile', status: GameStatus.coming_soon, maxPlayers: 4 },
    { id: 'mobile_legends', name: 'Mobile Legends', status: GameStatus.coming_soon, maxPlayers: 5 },
    { id: 'cod_mobile', name: 'Call of Duty Mobile', status: GameStatus.coming_soon, maxPlayers: 5 },
  ];

  for (const g of games) {
    await prisma.game.upsert({
      where: { id: g.id },
      update: { name: g.name, status: g.status, maxPlayers: g.maxPlayers },
      create: g,
    });
  }

  console.log('Seed completed: games inserted/updated.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
