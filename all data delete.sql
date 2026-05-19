-- Partybond: delete all app data except the games catalog
-- Safe to run in Supabase SQL Editor or psql
-- Does NOT touch: games, _prisma_migrations

BEGIN;

TRUNCATE TABLE
  analytics_events,
  pinned_messages,
  messages,
  conversation_participants,
  conversations,
  group_session_rsvps,
  squad_fill_invites,
  group_sessions,
  group_schedules,
  group_invites,
  group_members,
  groups,
  recent_players,
  interactions,
  matches,
  global_queue_entries,
  queue_entries,
  sessions,
  user_game_profiles,
  user_reports,
  user_blocks,
  users
RESTART IDENTITY CASCADE;

COMMIT;

-- Optional checks:
-- SELECT COUNT(*) FROM games;   -- unchanged (seed has 6 titles)
-- SELECT COUNT(*) FROM users;     -- 0