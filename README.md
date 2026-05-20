# Partybond — Backend

Node.js + Express + TypeScript + Prisma + PostgreSQL + Socket.IO.

## Setup

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init
npm run prisma:seed
npm run dev
```

The API runs at `http://localhost:4000` and exposes Socket.IO at the same origin.

## Production / `dist/`

`npm start` runs `prestart` → `npm run build` so `dist/` matches `src/` (the validate middleware uses Zod; an outdated build can **drop** fields such as `lookingFor` from `PATCH /users/me`). If you start the server with `node dist/server.js` directly, run `npm run build` after code changes.

## Environment

See `.env.example`. Important:

- `DATABASE_URL` — Postgres connection string.
- `JWT_SECRET` — used to sign authentication tokens.
- `FIREBASE_SERVICE_ACCOUNT_JSON` — single-line JSON of the service-account key (optional in dev — leaving it empty disables push without breaking the server).

## API surface (REST)

All under `/api/v1`. Bearer JWT required unless noted.

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Create account (email, password, name, age). Returns `{ token, user }`. Public. |
| POST | `/auth/forgot-password` | Send 6-digit code to email `{ identifier }`. Always returns success (no account enumeration). |
| POST | `/auth/reset-password` | Set new password `{ identifier, code, password }`. |
| POST | `/auth/login` | Log in. Returns `{ token, user }`. Public. |
| GET | `/auth/me` | Current user (with `gameProfiles`). |
| PATCH | `/users/me` | Update name, age, locale, selectedGame, **lookingFor** (≤200 chars). |
| POST | `/users/me/photo` | Upload profile photo (`multipart/form-data`, field `photo`). |
| PUT | `/users/me/fcm-token` | Save / clear FCM token. |
| PUT | `/users/me/game-profile` | Set `{ gameId, nickname, playerId }`. Also sets `selectedGame`. |
| GET | `/games` | List games (active + coming_soon). Public. |
| GET | `/sessions?gameId=…&gameMode=…&skillTier=…` | List open/active sessions (limit 20). Optional filters narrow matchmaking pools (same `gameMode` + `skillTier` = same lobby type). |
| POST | `/sessions` | Create session (`gameMode`, `skillTier`, `playersNeeded`, …). |
| GET | `/sessions/:id` | Session detail + waiting list. |
| POST | `/sessions/:id/queue` | Join queue. Triggers matchmaking. |
| DELETE | `/sessions/:id/queue` | Leave queue. |
| GET | `/matches/:id` | Match detail (participants only). |
| POST | `/matches/:id/interactions` | Quick action (`add_me`, `already_added`, `enter_lobby`, `waiting`, `did_not_work`). |
| POST | `/matches/:id/finish` | End the match manually. |

## Socket.IO events

Connect to `${API_URL}` with `{ auth: { token } }`.

Server emits:

- `match:created` — to each participant when a match is created. Payload includes opponent, sessionId, expiresAt.
- `match:interaction` — to the opposite participant on a quick action.
- `match:ended` — to both participants on finish/expire.
- `queue:update` — to subscribers of a session room (`session:subscribe <id>`).

Client emits:

- `session:subscribe <sessionId>` / `session:unsubscribe <sessionId>` — to receive queue updates.

## Matchmaking algorithm

Implemented in `src/services/matchmakingService.ts`:

1. **Transaction** with `SELECT … FOR UPDATE SKIP LOCKED` to atomically grab the 2 oldest queue entries — multiple concurrent matchmaker passes will not collide.
2. Re-check both users are still `in_queue`.
3. Insert `Match`, delete the 2 `QueueEntry` rows, update both users to `in_match`.
4. If session was `open`, promote to `active`.
5. Outside the transaction: fan out `match:created`, push notifications, analytics.

A `tryDrainSession(sessionId)` loop re-runs the pairing until no more matches are possible — handles bursts when several players join in quick succession.

## Cron jobs

`src/services/cleanupService.ts`:

- **every 1 min** — expire active matches past `expiresAt` (`match_timeout` analytics).
- **every 5 min** — flip scheduled sessions `open → active` when `scheduledAt` passes (auto activation, no button — Section 8 of the blueprint).
- **every hour** — delete finished sessions older than 24h.
- **every hour** — reset users stuck in inconsistent state (`in_match` with no active match, `in_queue` with no session).

## Analytics

`src/services/analyticsService.ts` records events to the `analytics_events` table:

`login`, `register`, `onboarding_complete`, `game_selected`, `session_created`, `session_enter`, `queue_join`, `queue_leave`, `match_start`, `interaction_sent`, `match_end`, `match_timeout`.

## Security

- `helmet` for sane HTTP headers.
- `cors` restricted to `CLIENT_ORIGINS` (or `*` in dev).
- `express-rate-limit` 300 req/min global.
- Authentication via Bearer JWT, signed with `JWT_SECRET`.
- Passwords hashed with bcrypt (cost 10).
- Multer image upload is restricted to PNG/JPG/WEBP, capped at `MAX_UPLOAD_SIZE_MB`.

## Production notes

- Build with `npm run build` and run `npm start`.
- Static `/uploads` directory should ideally be replaced with S3/Cloudflare R2 in production.
- For multi-instance deploys you'll want a Socket.IO adapter (Redis) — easy to add later.
