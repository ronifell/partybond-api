-- CreateEnum
CREATE TYPE "PlayStyle" AS ENUM ('relaxed', 'focused');
CREATE TYPE "GroupMemberRole" AS ENUM ('admin', 'member');
CREATE TYPE "GroupInviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'expired');
CREATE TYPE "ConversationType" AS ENUM ('direct', 'group');
CREATE TYPE "ScheduleFrequency" AS ENUM ('weekly', 'biweekly');
CREATE TYPE "RsvpStatus" AS ENUM ('confirmed', 'declined', 'pending');
CREATE TYPE "SquadFillInviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'expired');
CREATE TYPE "ReportCategory" AS ENUM ('spam', 'harassment', 'offensive_language', 'inappropriate_content', 'other');

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMP(3);
ALTER TABLE "user_game_profiles" ADD COLUMN IF NOT EXISTS "platform" TEXT;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "play_style" "PlayStyle";

-- CreateTable
CREATE TABLE "global_queue_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "game_mode" "SessionMode" NOT NULL,
    "play_style" "PlayStyle" NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "global_queue_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recent_players" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "player_user_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "platform" TEXT,
    "nickname" TEXT NOT NULL,
    "photo_url" TEXT,
    "last_played_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "recent_players_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "photo_url" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "GroupMemberRole" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "group_invites" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "invitee_id" TEXT NOT NULL,
    "status" "GroupInviteStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),
    CONSTRAINT "group_invites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL,
    "group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversation_participants" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_read_at" TIMESTAMP(3),
    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "reply_to_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pinned_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "pinned_by_id" TEXT NOT NULL,
    "pinned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pinned_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "group_schedules" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "time_local" TEXT NOT NULL,
    "frequency" "ScheduleFrequency" NOT NULL DEFAULT 'weekly',
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "group_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "group_sessions" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "schedule_id" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "group_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "group_session_rsvps" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "RsvpStatus" NOT NULL DEFAULT 'pending',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "group_session_rsvps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "squad_fill_invites" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "session_id" TEXT,
    "inviter_id" TEXT NOT NULL,
    "invitee_id" TEXT NOT NULL,
    "status" "SquadFillInviteStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "squad_fill_invites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_blocks" (
    "id" TEXT NOT NULL,
    "blocker_id" TEXT NOT NULL,
    "blocked_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_reports" (
    "id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "reported_id" TEXT NOT NULL,
    "category" "ReportCategory" NOT NULL,
    "details" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_reports_pkey" PRIMARY KEY ("id")
);

-- Indexes & uniques
CREATE UNIQUE INDEX "global_queue_entries_user_id_key" ON "global_queue_entries"("user_id");
CREATE INDEX "global_queue_entries_game_id_joined_at_idx" ON "global_queue_entries"("game_id", "joined_at");
CREATE UNIQUE INDEX "recent_players_owner_id_player_user_id_game_id_key" ON "recent_players"("owner_id", "player_user_id", "game_id");
CREATE INDEX "recent_players_owner_id_last_played_at_idx" ON "recent_players"("owner_id", "last_played_at" DESC);
CREATE UNIQUE INDEX "group_members_group_id_user_id_key" ON "group_members"("group_id", "user_id");
CREATE INDEX "group_invites_invitee_id_status_idx" ON "group_invites"("invitee_id", "status");
CREATE UNIQUE INDEX "conversations_group_id_key" ON "conversations"("group_id");
CREATE UNIQUE INDEX "conversation_participants_conversation_id_user_id_key" ON "conversation_participants"("conversation_id", "user_id");
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");
CREATE UNIQUE INDEX "pinned_messages_message_id_key" ON "pinned_messages"("message_id");
CREATE INDEX "group_sessions_group_id_starts_at_idx" ON "group_sessions"("group_id", "starts_at");
CREATE UNIQUE INDEX "group_session_rsvps_session_id_user_id_key" ON "group_session_rsvps"("session_id", "user_id");
CREATE INDEX "squad_fill_invites_invitee_id_status_idx" ON "squad_fill_invites"("invitee_id", "status");
CREATE UNIQUE INDEX "user_blocks_blocker_id_blocked_id_key" ON "user_blocks"("blocker_id", "blocked_id");
CREATE INDEX "user_reports_reported_id_created_at_idx" ON "user_reports"("reported_id", "created_at");

-- ForeignKeys
ALTER TABLE "global_queue_entries" ADD CONSTRAINT "global_queue_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "global_queue_entries" ADD CONSTRAINT "global_queue_entries_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recent_players" ADD CONSTRAINT "recent_players_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recent_players" ADD CONSTRAINT "recent_players_player_user_id_fkey" FOREIGN KEY ("player_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recent_players" ADD CONSTRAINT "recent_players_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "group_invites" ADD CONSTRAINT "group_invites_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_pinned_by_id_fkey" FOREIGN KEY ("pinned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "group_schedules" ADD CONSTRAINT "group_schedules_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_sessions" ADD CONSTRAINT "group_sessions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_sessions" ADD CONSTRAINT "group_sessions_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "group_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "group_session_rsvps" ADD CONSTRAINT "group_session_rsvps_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "group_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_session_rsvps" ADD CONSTRAINT "group_session_rsvps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "squad_fill_invites" ADD CONSTRAINT "squad_fill_invites_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "squad_fill_invites" ADD CONSTRAINT "squad_fill_invites_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "group_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "squad_fill_invites" ADD CONSTRAINT "squad_fill_invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "squad_fill_invites" ADD CONSTRAINT "squad_fill_invites_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
