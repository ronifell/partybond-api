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

### Password reset email (Gmail SMTP)

Set in `.env` (see `.env.example`):

- `MAIL_HOST=smtp.gmail.com`
- `MAIL_PORT=587`
- `MAIL_USERNAME` — your Gmail address
- `MAIL_PASSWORD` — [Gmail App Password](https://myaccount.google.com/apppasswords) (16 characters, not your normal Gmail password)
- `MAIL_FROM_NAME` — optional display name (default `Partybond`)

Requires **2-Step Verification** on the Google account. Emails can be sent to **any** registered user address. Restart the API after changing `.env` (e.g. `pm2 restart partybond-api`).

### Google Sign-In

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. Create **OAuth client ID** → type **Web** → copy to `GOOGLE_WEB_CLIENT_ID` (backend `.env`) and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (frontend `.env`).
3. Create **Android** (`com.partybond.app` + SHA-1) and **iOS** (`com.partybond.app`) clients for release builds.
4. Configure **OAuth consent screen** (add test users while in Testing mode).
5. Run `npx prisma migrate deploy` for the `google_id` column.
6. **Web client → Authorized redirect URIs:** only `https://` or `http://` URLs are allowed. Add `https://auth.expo.io/@YOUR_EXPO_USERNAME/partybond` for Expo Go. **Do not** add `partybond://` here — Google rejects it (“must contain a domain”). EAS/APK builds use Expo’s default redirect `com.partybond.app:/oauthredirect`, which is tied to your **Android** OAuth client (package + SHA-1), not the Web redirect list.

### Google Play Billing (Premium subscriptions)

Premium unlocks the **automatic group formation** feature. The backend verifies every Google Play purchase server-side and stores entitlement in the `Subscription` table (cached on `User.premiumUntil` for fast checks).

1. Google Play Console → your app → **Monetisation setup → Subscriptions**. Create one subscription product (e.g. `partybond_premium_monthly`) with at least one base plan. Copy the product ID into `GOOGLE_PLAY_PREMIUM_PRODUCT_IDS` (comma separated if you have multiple, e.g. `partybond_premium_monthly,partybond_premium_yearly`) and into the frontend `EXPO_PUBLIC_PREMIUM_PRODUCT_IDS`.
2. Make sure `GOOGLE_PLAY_PACKAGE_NAME` matches the Android package (`com.partybond.app`).
3. **Service account** for the Android Publisher API:
   - Google Cloud Console → IAM → **Create service account** in the same project linked to Play Console.
   - Generate a **JSON key**. Copy its full JSON content into `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` as a single line (escape newlines or use the raw JSON depending on your env loader).
   - Play Console → **Users & permissions → Invite new users**, add the service account email. Grant **View financial data** and **Manage orders & subscriptions** for the app.
4. Restart the API. Verification happens at `POST /billing/google-play/verify { productId, purchaseToken }`, called from the client after a successful purchase. The endpoint upserts the subscription and recomputes `premiumUntil` from the latest `expiryTimeMillis`.
5. Refresh from the client side with `GET /billing/refresh` (re-checks all stored tokens against Google). Schedule a daily cron in production if you need defensive expiry handling beyond the 30s `cronTickAutoGroups` tick.
6. To grant premium manually (referral reward, support, comp): `grantManualPremium(userId, days)` from `billingService` is exposed indirectly through `redeemReferralOnSignup`.

### Referrals & invite links

Users share `${INVITE_BASE_URL}/i/<CODE>` (e.g. `https://api.partybond.app/i/AB23KX9Y`). The backend serves a smart redirect:

- **Android UA** → Play Store with `referrer=invite_<CODE>` (so the app can pick it up via install-referrer if you wire it later).
- **iOS UA** → `APP_STORE_URL` (set when the iOS app ships).
- **Desktop / other** → tiny HTML landing page with both store buttons.

When a new user signs up with `inviteCode` in the body (`POST /auth/register { …, inviteCode }`), `redeemReferralOnSignup` grants the **inviter** `REFERRAL_REWARD_DAYS` free Premium days (default 7) and writes a `Referral` row. The frontend pre-fills this field from the clipboard if it detects a valid code, but the user can paste/type it manually too.

| Env var | Purpose | Example |
|---|---|---|
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Single-line JSON for the Publisher API service account | `{"type":"service_account",…}` |
| `GOOGLE_PLAY_PACKAGE_NAME` | Android package name | `com.partybond.app` |
| `GOOGLE_PLAY_PREMIUM_PRODUCT_IDS` | Comma-separated subscription IDs to consider Premium | `partybond_premium_monthly` |
| `INVITE_BASE_URL` | Public base URL used in shareable invite links | `https://api.partybond.app` |
| `APP_STORE_URL` | iOS App Store URL (optional, falls back to landing) | `https://apps.apple.com/app/id…` |
| `REFERRAL_REWARD_DAYS` | Free Premium days credited to the inviter on signup | `7` |

## API surface (REST)

All under `/api/v1`. Bearer JWT required unless noted.

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Create account (email, password, name, age). Returns `{ token, user }`. Public. |
| POST | `/auth/forgot-password` | Send 6-digit code to email `{ identifier }`. Always returns success (no account enumeration). |
| POST | `/auth/reset-password` | Set new password `{ identifier, code, password }`. |
| POST | `/auth/login` | Log in. Returns `{ token, user }`. Public. |
| POST | `/auth/google` | Google Sign-In `{ idToken, locale? }`. Returns `{ token, user }`. Public. |
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
| GET | `/billing/products` | Configured premium product IDs. Public. |
| GET | `/billing/me` | Current user's premium status + stored subscriptions. |
| POST | `/billing/refresh` | Re-verify every stored subscription against Google Play. |
| POST | `/billing/google-play/verify` | `{ productId, purchaseToken }` — verify a fresh purchase, persist, grant Premium. |
| GET | `/referrals/me` | User's invite code + shareable link + stats. |
| GET | `/referrals/history` | List of redemptions this user made (as inviter). |
| POST | `/referrals/redeem` | `{ code }` — redeem post-signup (mostly used by the register flow). |
| GET | `/referrals/lookup/:code` | Public — returns inviter display name for landing pages. |
| GET | `/i/:code` | Public — UA-aware redirect (Android → Play, iOS → App Store, desktop → landing). |
| GET | `/auto-groups` | List the user's auto-group requests. |
| POST | `/auto-groups` | **Premium only.** Create an auto-group request (game, players needed, mode/style/skill). Spawns the group, picks initial candidates, sends squad-fill invites. |
| GET | `/auto-groups/:id` | Status + confirmed members + pending invites. |
| POST | `/auto-groups/:id/cancel` | Cancel the search; pending invites are revoked. |

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
- **every 30s** — `cronTickAutoGroups` runs another matching wave for any pending auto-group request, expires stale ones, and marks fulfilled groups when the target count is reached.

## Analytics

`src/services/analyticsService.ts` records events to the `analytics_events` table:

`login`, `register`, `onboarding_complete`, `game_selected`, `session_created`, `session_enter`, `queue_join`, `queue_leave`, `match_start`, `interaction_sent`, `match_end`, `match_timeout`, `subscription_verified`, `premium_granted`, `referral_redeemed`, `auto_group_started`, `auto_group_canceled`, `auto_group_fulfilled`.

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
