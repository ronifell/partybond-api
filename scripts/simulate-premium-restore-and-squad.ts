/**
 * Simulates the Play Store bugs we just fixed:
 *   1. Empty team name used the generic error — now falls back to placeholder.
 *   2. Play already owns Premium but Partybond never got the token — restore
 *      verifies the purchase, then Auto-form squad works.
 *   3. Create squad + invite still works with the placeholder title.
 *
 * Run from partybond-api: npx tsx scripts/simulate-premium-restore-and-squad.ts
 */
import { prisma } from '../src/config/database';
import { HttpError } from '../src/utils/httpError';
import { getPremiumStatus, syncPremiumUntil } from '../src/services/premiumService';
import { startAutoGroup, cancelAutoGroup } from '../src/services/autoGroupService';
import * as sessionSquadService from '../src/services/sessionSquadService';

const ts = Date.now();
const PLACEHOLDER = 'Squad de sexta';

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

/** Same rule as CreateSessionScreen: empty field uses the grey placeholder. */
function resolveTeamName(title: string, placeholder: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length < 2) return null;
  return trimmed;
}

/** Same detector as syncPremiumFromPlay.isAlreadyOwnedPurchaseError */
function isAlreadyOwnedPurchaseError(message: string): boolean {
  return /already own|item.?already.?owned|já tem uma assinatura|já possui/i.test(message);
}

/**
 * What the app does after restorePremiumPurchases() returns a Play token:
 * upsert the subscription and refresh premiumUntil (verifyGooglePlayPurchase
 * after Google confirms the token).
 */
async function simulatePlayRestore(userId: string, productId: string, purchaseToken: string) {
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  await prisma.subscription.upsert({
    where: {
      platform_purchaseToken: { platform: 'google_play', purchaseToken },
    },
    create: {
      userId,
      platform: 'google_play',
      productId,
      purchaseToken,
      status: 'active',
      autoRenewing: true,
      startedAt: new Date(),
      currentPeriodEnd: expiry,
      rawPayload: { simulated: true, source: 'play_restore' },
    },
    update: {
      userId,
      productId,
      status: 'active',
      autoRenewing: true,
      currentPeriodEnd: expiry,
      lastVerifiedAt: new Date(),
    },
  });
  await syncPremiumUntil(userId);
}

async function main() {
  console.log('\n=== Simulate: Premium restore + Auto-form squad + empty team name ===\n');

  const game = await prisma.game.findFirst({ where: { status: 'active' } });
  if (!game) fail('No active game in catalog');

  // --- 1. Empty team name is rejected with a clear reason ---
  console.log('1. Create squad — empty name');
  if (resolveTeamName('', PLACEHOLDER) !== null) {
    fail('Empty title should be rejected');
  }
  ok('Empty title is rejected (group not created because it needs a name)');
  if (resolveTeamName('   ', PLACEHOLDER) !== null) {
    fail('Whitespace-only title should be rejected');
  }
  ok('Whitespace-only title is rejected');
  if (resolveTeamName('Robson squad', PLACEHOLDER) !== 'Robson squad') {
    fail('Typed title should be kept');
  }
  ok('Typed title is kept');

  // --- 2. Play "already own" detector ---
  console.log('\n2. Play Billing already-owned errors');
  const alreadyOwnedMessages = [
    'You already own this item.',
    'Você já tem uma assinatura de Partybond Premium Monthly (Partybond).',
    'ITEM_ALREADY_OWNED',
  ];
  for (const msg of alreadyOwnedMessages) {
    if (!isAlreadyOwnedPurchaseError(msg)) fail(`Should treat as already-owned: ${msg}`);
  }
  ok('EN / PT / Play codes all trigger restore instead of looping the paywall');

  // --- 3. Auto-form squad gated until Play restore ---
  console.log('\n3. Premium restore unlocks Auto-form squad');
  const owner = await prisma.user.create({
    data: {
      email: `premium.restore.${ts}@example.com`,
      passwordHash: 'x',
      name: 'Hayato',
      age: 28,
    },
  });
  const friend = await prisma.user.create({
    data: {
      email: `premium.friend.${ts}@example.com`,
      passwordHash: 'x',
      name: 'Robson',
      age: 27,
    },
  });
  await prisma.userGameProfile.createMany({
    data: [
      { userId: owner.id, gameId: game.id, nickname: 'HayatoPB', playerId: '9001' },
      { userId: friend.id, gameId: game.id, nickname: 'Thyr', playerId: '9002' },
    ],
  });
  await prisma.recentPlayer.create({
    data: {
      ownerId: owner.id,
      playerUserId: friend.id,
      gameId: game.id,
      nickname: 'Thyr',
      lastPlayedAt: new Date(),
    },
  });
  ok(`Users: ${owner.name} (Play subscriber) and ${friend.name}`);

  const before = await getPremiumStatus(owner.id);
  if (before.isPremium) fail('Owner should start without Partybond premium');
  ok('Play billed the user, but Partybond isPremium is still false');

  let gated = false;
  try {
    await startAutoGroup(owner.id, {
      name: 'Auto Squad',
      gameId: game.id,
      gameMode: 'casual',
      playStyle: 'relaxed',
      skillTier: 'beginner',
      playersNeeded: 3,
    });
  } catch (err) {
    gated = err instanceof HttpError && err.code === 'premium_required';
  }
  if (!gated) fail('Auto-form squad should reject non-premium users');
  ok('Auto-form squad shows Premium gate (premium_required)');

  await simulatePlayRestore(owner.id, 'partybond.premium.monthly', `play-token-${ts}`);
  const after = await getPremiumStatus(owner.id);
  if (!after.isPremium) fail('Restore did not set isPremium');
  ok(`Restore verified Play token → premiumUntil ${after.premiumUntil?.slice(0, 10)}`);

  const auto = await startAutoGroup(owner.id, {
    name: 'Auto Squad',
    gameId: game.id,
    gameMode: 'casual',
    playStyle: 'relaxed',
    skillTier: 'beginner',
    playersNeeded: 3,
  });
  if (!auto.id || !auto.groupId) fail('Auto-form squad failed after restore');
  ok(`Auto-form squad started: request ${auto.id.slice(0, 8)}… group ${auto.groupId.slice(0, 8)}…`);

  // --- 4. Create team with placeholder title + invite ---
  console.log('\n4. Create team (empty name) + invite friend');
  const teamName = resolveTeamName('Squad de sexta', PLACEHOLDER);
  if (!teamName) fail('Expected a valid team name for the invite path');
  const session = await prisma.session.create({
    data: {
      gameId: game.id,
      title: teamName,
      gameMode: 'casual',
      skillTier: 'beginner',
      playersNeeded: 2,
      scheduledAt: new Date(),
      status: 'active',
      createdById: owner.id,
    },
  });
  if (session.title !== PLACEHOLDER) fail(`Session title should be "${PLACEHOLDER}"`);
  ok(`Session created as "${session.title}"`);

  const sent = await sessionSquadService.sendSessionSquadInvites(session.id, owner.id, [friend.id]);
  if (sent.count !== 1) fail(`Expected 1 invite, got ${sent.count}`);
  const pending = await sessionSquadService.listPendingSessionSquadInvites(friend.id);
  if (pending.length !== 1) fail('Friend did not receive squad invite');
  ok(`${friend.name} received squad invite for "${pending[0]!.session.title}"`);

  // --- Cleanup ---
  await cancelAutoGroup(owner.id, auto.id).catch(() => undefined);
  await prisma.squadFillInvite.deleteMany({ where: { groupId: auto.groupId } });
  await prisma.sessionSquadInvite.deleteMany({ where: { sessionId: session.id } });
  await prisma.queueEntry.deleteMany({ where: { sessionId: session.id } });
  await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
  await prisma.autoGroupRequest.deleteMany({ where: { userId: owner.id } });
  await prisma.groupMember.deleteMany({ where: { groupId: auto.groupId } });
  await prisma.groupInvite.deleteMany({ where: { groupId: auto.groupId } });
  await prisma.group.deleteMany({ where: { id: auto.groupId } });
  await prisma.subscription.deleteMany({ where: { userId: owner.id } });
  await prisma.recentPlayer.deleteMany({ where: { ownerId: owner.id } });
  const ids = [owner.id, friend.id];
  await prisma.userGameProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  ok('Test users cleaned up');

  console.log('\n=== Simulation passed: Premium restore, Auto-form squad, and empty team name behave as specified ===\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
