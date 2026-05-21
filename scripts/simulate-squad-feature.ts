/**
 * Simulates the "Criar equipe" flow against the real DB (no HTTP server).
 * Run: npx tsx scripts/simulate-squad-feature.ts
 */
import { prisma } from '../src/config/database';
import * as sessionSquadService from '../src/services/sessionSquadService';

const ts = Date.now();

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string) {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

async function main() {
  console.log('\n=== Simulate: Criar equipe / squad invites ===\n');

  const game = await prisma.game.findFirst({ where: { status: 'active' } });
  if (!game) fail('No active game in catalog');

  const leader = await prisma.user.create({
    data: {
      email: `squad_leader_${ts}@test.partybond`,
      passwordHash: 'x',
      name: 'Tiago',
      age: 25,
    },
  });
  const invitee = await prisma.user.create({
    data: {
      email: `squad_invitee_${ts}@test.partybond`,
      passwordHash: 'x',
      name: 'Joao',
      age: 26,
    },
  });

  await prisma.userGameProfile.createMany({
    data: [
      { userId: leader.id, gameId: game.id, nickname: 'TiagoFF', playerId: '111' },
      { userId: invitee.id, gameId: game.id, nickname: 'JoaoFF', playerId: '222' },
    ],
  });

  await prisma.recentPlayer.create({
    data: {
      ownerId: leader.id,
      playerUserId: invitee.id,
      gameId: game.id,
      nickname: 'JoaoFF',
      lastPlayedAt: new Date(),
    },
  });

  ok(`Users created: ${leader.name} → invites ${invitee.name}`);

  const candidates = await sessionSquadService.listSquadCandidates(leader.id, game.id);
  if (!candidates.some((c) => c.userId === invitee.id)) {
    fail('Invitee missing from squad candidates');
  }
  ok(`Squad candidates: ${candidates.length} (includes recent player)`);

  const session = await prisma.session.create({
    data: {
      gameId: game.id,
      title: `Squad Sim ${ts}`,
      gameMode: 'casual',
      skillTier: 'beginner',
      playersNeeded: 4,
      scheduledAt: new Date(),
      status: 'active',
      createdById: leader.id,
    },
  });
  ok(`Session created: ${session.id.slice(0, 10)}…`);

  const sent = await sessionSquadService.sendSessionSquadInvites(session.id, leader.id, [
    invitee.id,
  ]);
  if (sent.count !== 1) fail(`Expected 1 invite sent, got ${sent.count}`);
  ok('Squad invite sent');

  const pending = await sessionSquadService.listPendingSessionSquadInvites(invitee.id);
  if (pending.length !== 1) fail(`Expected 1 pending invite, got ${pending.length}`);
  if (pending[0]!.inviter.name !== 'Tiago') fail('Inviter name wrong on pending invite');
  if (!pending[0]!.session.gameName) fail('Game name missing on invite');
  ok(`Pending invite UI text: convite de squad de ${pending[0]!.inviter.name} para ${pending[0]!.session.gameName}`);

  await sessionSquadService.respondSessionSquadInvite(pending[0]!.id, invitee.id, true);
  ok('Invite accepted');

  const inviteeUser = await prisma.user.findUnique({ where: { id: invitee.id } });
  if (inviteeUser?.state !== 'in_queue' || inviteeUser.currentSessionId !== session.id) {
    fail(`After accept: expected in_queue on session, got ${inviteeUser?.state}`);
  }
  ok('Invitee joined session queue');

  const pendingAfter = await sessionSquadService.listPendingSessionSquadInvites(invitee.id);
  if (pendingAfter.length > 0) fail('Accepted invite still pending');
  ok('Invite removed from pending list');

  // Decline path (second user)
  const decliner = await prisma.user.create({
    data: {
      email: `squad_decline_${ts}@test.partybond`,
      passwordHash: 'x',
      name: 'Maria',
      age: 24,
    },
  });
  await prisma.userGameProfile.create({
    data: { userId: decliner.id, gameId: game.id, nickname: 'MariaFF', playerId: '333' },
  });
  const sent2 = await sessionSquadService.sendSessionSquadInvites(session.id, leader.id, [
    decliner.id,
  ]);
  const pend2 = await sessionSquadService.listPendingSessionSquadInvites(decliner.id);
  await sessionSquadService.respondSessionSquadInvite(pend2[0]!.id, decliner.id, false);
  const pend2After = await sessionSquadService.listPendingSessionSquadInvites(decliner.id);
  if (pend2After.length > 0) fail('Declined invite still pending');
  ok('Decline path works');

  // Cleanup
  await prisma.sessionSquadInvite.deleteMany({ where: { sessionId: session.id } });
  await prisma.queueEntry.deleteMany({ where: { sessionId: session.id } });
  await prisma.session.delete({ where: { id: session.id } });
  await prisma.recentPlayer.deleteMany({
    where: { ownerId: leader.id, playerUserId: invitee.id },
  });
  const allUserIds = [leader.id, invitee.id, decliner.id];
  await prisma.userGameProfile.deleteMany({ where: { userId: { in: allUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });

  console.log('\n=== Simulation passed: feature behaves as specified ===\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
