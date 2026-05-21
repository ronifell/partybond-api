/**
 * End-to-end API integration test for Partybond v4 features.
 * Run: npx tsx scripts/integration-test.ts
 */
const BASE = process.env.API_BASE ?? 'http://localhost:4000/api/v1';

type Json = Record<string, unknown>;

let passed = 0;
let failed = 0;

function ok(name: string, detail?: string) {
  passed += 1;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, err: unknown) {
  failed += 1;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  ✗ ${name} — ${msg}`);
}

async function req(
  method: string,
  path: string,
  opts?: { token?: string; body?: Json },
): Promise<{ status: number; data: Json }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  let data: Json = {};
  try {
    data = (await res.json()) as Json;
  } catch {
    data = {};
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } }).error;
    throw new Error(`${res.status} ${err?.code ?? ''}: ${err?.message ?? res.statusText}`);
  }
  return { status: res.status, data };
}

async function registerOrLogin(email: string, name: string) {
  try {
    const { data } = await req('POST', '/auth/register', {
      body: { email, password: 'testpass123', name, age: 25, locale: 'en' },
    });
    return (data as { token: string; user: { id: string } }).token;
  } catch {
    const { data } = await req('POST', '/auth/login', {
      body: { email, password: 'testpass123' },
    });
    return (data as { token: string }).token;
  }
}

async function main() {
  console.log('\n=== Partybond integration test ===\n');
  console.log(`API: ${BASE}\n`);

  const ts = Date.now();
  const emailA = `testa_${ts}@partybond.test`;
  const emailB = `testb_${ts}@partybond.test`;
  let tokenA = '';
  let tokenB = '';
  let userAId = '';
  let userBId = '';
  let matchId = '';
  let groupId = '';
  let inviteId = '';
  let convDirectId = '';
  let convGroupId = '';

  // --- Health ---
  try {
    const h = await fetch('http://localhost:4000/health');
    if (!h.ok) throw new Error('health not ok');
    ok('Health endpoint');
  } catch (e) {
    fail('Health endpoint', e);
    process.exit(1);
  }

  // --- Matchmaking route exists ---
  try {
    const r = await fetch(`${BASE}/matchmaking/queue/status`, {
      headers: { Authorization: 'Bearer invalid' },
    });
    if (r.status === 404) throw new Error('matchmaking routes not mounted');
    ok('Matchmaking routes mounted', `status ${r.status}`);
  } catch (e) {
    fail('Matchmaking routes mounted', e);
  }

  // --- Auth + profiles ---
  try {
    tokenA = await registerOrLogin(emailA, 'Tiago');
    tokenB = await registerOrLogin(emailB, 'Joao');
    const meA = await req('GET', '/auth/me', { token: tokenA });
    const meB = await req('GET', '/auth/me', { token: tokenB });
    userAId = (meA.data.user as { id: string }).id;
    userBId = (meB.data.user as { id: string }).id;
    ok('Register/login two users', `${userAId.slice(0, 8)}… / ${userBId.slice(0, 8)}…`);
  } catch (e) {
    fail('Register/login two users', e);
    process.exit(1);
  }

  try {
    const games = await req('GET', '/games', { token: tokenA });
    const list = (games.data as { games: Array<{ id: string; status: string }> }).games;
    const game = list.find((g) => g.status === 'active') ?? list[0];
    if (!game) throw new Error('no games in catalog');
    const gameId = game.id;
    await req('PUT', '/users/me/game-profile', {
      token: tokenA,
      body: { gameId, nickname: 'TiagoFF', playerId: '111111' },
    });
    await req('PUT', '/users/me/game-profile', {
      token: tokenB,
      body: { gameId, nickname: 'JoaoFF', playerId: '222222' },
    });
    ok('Game profiles', gameId);

    // --- Progressive queue + match ---
    await req('POST', '/matchmaking/queue', {
      token: tokenA,
      body: { gameId, gameMode: 'casual', playStyle: 'relaxed' },
    });
    const statusA = await req('GET', '/matchmaking/queue/status', { token: tokenA });
    const phase = (statusA.data.status as { phase: number })?.phase;
    if (!phase) throw new Error('no queue status');
    ok('User A joined progressive queue', `phase ${phase}`);

    await req('POST', '/matchmaking/queue', {
      token: tokenB,
      body: { gameId, gameMode: 'casual', playStyle: 'relaxed' },
    });
    ok('User B joined progressive queue');

    let sA = { state: 'in_queue', currentMatchId: null as string | null };
    let sB = { state: 'in_queue', currentMatchId: null as string | null };
    for (let i = 0; i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const stateA = await req('GET', '/users/me/state', { token: tokenA });
      const stateB = await req('GET', '/users/me/state', { token: tokenB });
      sA = stateA.data as typeof sA;
      sB = stateB.data as typeof sB;
      if (sA.state === 'in_match' && sB.state === 'in_match') break;
    }
    if (sA.state !== 'in_match' || sB.state !== 'in_match') {
      throw new Error(`expected in_match, got A=${sA.state} B=${sB.state}`);
    }
    matchId = sA.currentMatchId!;
    if (!matchId || matchId !== sB.currentMatchId) throw new Error('match ids mismatch');
    ok('Progressive match created', matchId);

    await req('POST', `/matches/${matchId}/finish`, { token: tokenA });
    await req('POST', `/matches/${matchId}/finish`, { token: tokenB });
    ok('Match finished');

    const recentA = await req('GET', '/users/me/recent-players', { token: tokenA });
    const players = (recentA.data as { players: Array<{ userId: string }> }).players;
    if (!players.some((p) => p.userId === userBId)) throw new Error('B not in A recent list');
    ok('Recent players populated', `${players.length} entries`);

    // --- Create team / session squad invites ---
    const squadSession = await req('POST', '/sessions', {
      token: tokenA,
      body: {
        gameId,
        title: `Squad Test ${ts}`,
        gameMode: 'casual',
        skillTier: 'beginner',
        playersNeeded: 4,
      },
    });
    const playSessionId = (squadSession.data.session as { id: string }).id;
    ok('Play session created for squad', playSessionId.slice(0, 8) + '…');

    const candidates = await req('GET', `/users/me/squad-candidates?gameId=${gameId}`, {
      token: tokenA,
    });
    const candidateList = (candidates.data as { candidates: Array<{ userId: string }> }).candidates;
    if (!candidateList.some((c) => c.userId === userBId)) {
      throw new Error('User B should appear in squad candidates after match');
    }
    ok('Squad candidates list', `${candidateList.length} candidates, includes B`);

    await req('POST', `/sessions/${playSessionId}/squad-invites`, {
      token: tokenA,
      body: { inviteeIds: [userBId] },
    });
    ok('Squad invite sent to B');

    const pendingSquadB = await req('GET', '/sessions/squad-invites/pending', { token: tokenB });
    const squadInvites = (pendingSquadB.data as {
      invites: Array<{ id: string; inviter: { name: string }; session: { gameName: string } }>;
    }).invites;
    const squadInviteId = squadInvites[0]?.id;
    if (!squadInviteId) throw new Error('no pending squad invite for B');
    if (!squadInvites[0]!.inviter.name) throw new Error('inviter name missing');
    ok('Pending squad invite for B', squadInvites[0]!.session.gameName);

    await req('POST', `/sessions/squad-invites/${squadInviteId}/respond`, {
      token: tokenB,
      body: { accept: true },
    });
    ok('Squad invite accepted by B');

    const stateAfter = await req('GET', '/users/me/state', { token: tokenB });
    const sAfter = stateAfter.data as { state: string; currentSessionId: string | null };
    if (sAfter.state !== 'in_queue' || sAfter.currentSessionId !== playSessionId) {
      throw new Error(`B should be in_queue on session, got ${sAfter.state} ${sAfter.currentSessionId}`);
    }
    ok('Invitee joined session queue after accept');

    const pendingAfter = await req('GET', '/sessions/squad-invites/pending', { token: tokenB });
    const stillPending = (pendingAfter.data as { invites: unknown[] }).invites.length;
    if (stillPending > 0) throw new Error('accepted invite should not stay pending');
    ok('Squad invite cleared from pending');

    // --- Groups ---
    const grp = await req('POST', '/groups', {
      token: tokenA,
      body: { name: `Squad Test ${ts}`, memberIds: [] },
    });
    groupId = (grp.data.group as { id: string }).id;
    ok('Group created', groupId);

    await req('POST', `/groups/${groupId}/invites`, {
      token: tokenA,
      body: { inviteeId: userBId },
    });
    const pendingB = await req('GET', '/groups/invites/pending', { token: tokenB });
    const invites = (pendingB.data as { invites: Array<{ id: string }> }).invites;
    inviteId = invites[0]?.id;
    if (!inviteId) throw new Error('no pending invite for B');
    ok('Group invite sent');

    await req('POST', `/groups/invites/${inviteId}/respond`, {
      token: tokenB,
      body: { accept: true },
    });
    ok('Group invite accepted');

    const detail = await req('GET', `/groups/${groupId}`, { token: tokenA });
    const g = detail.data.group as { members: Array<{ id: string }>; conversationId: string | null };
    if (!g.members.some((m) => m.id === userBId)) throw new Error('B not in group members');
    convGroupId = g.conversationId ?? '';
    ok('Group has both members', `conversation ${convGroupId.slice(0, 8)}…`);

    // --- Schedule + RSVP ---
    const sched = await req('POST', `/groups/${groupId}/schedules`, {
      token: tokenA,
      body: { dayOfWeek: 2, timeLocal: '21:00', frequency: 'weekly' },
    });
    const sessionId = (sched.data.nextSession as { id: string }).id;
    await req('POST', `/groups/sessions/${sessionId}/rsvp`, {
      token: tokenA,
      body: { status: 'confirmed' },
    });
    ok('Group schedule + RSVP');

    // --- Squad fill suggestions ---
    const fill = await req('GET', `/groups/${groupId}/squad-fill/suggestions`, { token: tokenA });
    const suggestions = (fill.data as { suggestions: unknown[] }).suggestions;
    ok('Squad fill suggestions', `${suggestions.length} suggestions`);

    // --- Chat direct ---
    const dm = await req('POST', '/chats/direct', { token: tokenA, body: { userId: userBId } });
    convDirectId = (dm.data.conversation as { id: string }).id;
    await req('POST', `/chats/${convDirectId}/messages`, {
      token: tokenA,
      body: { body: 'Hello from integration test' },
    });
    const msgs = await req('GET', `/chats/${convDirectId}/messages`, { token: tokenB });
    const dmMessages = (msgs.data as { messages: Array<{ body: string }> }).messages;
    if (!dmMessages.some((m) => m.body.includes('integration test'))) throw new Error('DM not received');
    ok('Direct chat send/receive');

    if (convGroupId) {
      await req('POST', `/chats/${convGroupId}/messages`, {
        token: tokenA,
        body: { body: 'Group hello' },
      });
      ok('Group chat message sent');
    }

    // --- Moderation ---
    await req('POST', '/moderation/report', {
      token: tokenA,
      body: { reportedId: userBId, category: 'spam', details: 'test' },
    });
    ok('Report user');

    await req('POST', '/moderation/block', { token: tokenA, body: { userId: userBId } });
    ok('Block user');

    await req('DELETE', '/matchmaking/queue', { token: tokenA }).catch(() => {});
    await req('DELETE', '/matchmaking/queue', { token: tokenB }).catch(() => {});
  } catch (e) {
    fail('Feature flow', e);
  }

  // --- Remote server check (user's Expo URL) ---
  const remote = 'http://18.231.112.145:4000';
  try {
    const r = await fetch(`${remote}/api/v1/matchmaking/queue/status`, {
      headers: { Authorization: 'Bearer x' },
    });
    if (r.status === 404) {
      console.log('\n  ⚠ Remote API (18.231.112.145) missing /matchmaking — Expo Quick Join will fail until deployed.\n');
    } else {
      ok('Remote server has matchmaking routes', `status ${r.status}`);
    }
  } catch {
    console.log('\n  ⚠ Remote API unreachable — use local EXPO_PUBLIC_API_URL for device testing.\n');
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
