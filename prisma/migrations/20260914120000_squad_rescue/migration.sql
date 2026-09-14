-- Squad Rescue (web): optional session fields, guest identity, members, communities.
-- Additive only — existing mobile sessions and users are unchanged.

CREATE TYPE "SquadRescueStatus" AS ENUM ('open', 'completed', 'cancelled', 'expired');

ALTER TABLE "users" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "guest_key" TEXT;

CREATE UNIQUE INDEX "users_guest_key_key" ON "users"("guest_key");

ALTER TABLE "sessions" ADD COLUMN "rescue_code" TEXT;
ALTER TABLE "sessions" ADD COLUMN "rescue_status" "SquadRescueStatus";
ALTER TABLE "sessions" ADD COLUMN "rescue_platform" "GamePlatform";
ALTER TABLE "sessions" ADD COLUMN "rescue_mic_required" BOOLEAN;
ALTER TABLE "sessions" ADD COLUMN "rescue_game_label" VARCHAR(80);
ALTER TABLE "sessions" ADD COLUMN "rescue_expires_at" TIMESTAMP(3);
ALTER TABLE "sessions" ADD COLUMN "rescue_community_id" TEXT;
ALTER TABLE "sessions" ADD COLUMN "rescue_closed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "sessions_rescue_code_key" ON "sessions"("rescue_code");
CREATE INDEX "sessions_rescue_status_rescue_expires_at_idx" ON "sessions"("rescue_status", "rescue_expires_at");

CREATE TABLE "communities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_url" TEXT,
    "visit_count" INTEGER NOT NULL DEFAULT 0,
    "squads_created" INTEGER NOT NULL DEFAULT 0,
    "squads_completed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "squad_rescue_members" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "game_uid" TEXT NOT NULL,
    "has_mic" BOOLEAN NOT NULL DEFAULT false,
    "is_creator" BOOLEAN NOT NULL DEFAULT false,
    "left_at" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "squad_rescue_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "squad_rescue_members_session_id_user_id_key" ON "squad_rescue_members"("session_id", "user_id");
CREATE INDEX "squad_rescue_members_session_id_left_at_idx" ON "squad_rescue_members"("session_id", "left_at");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_rescue_community_id_fkey"
  FOREIGN KEY ("rescue_community_id") REFERENCES "communities"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "squad_rescue_members"
  ADD CONSTRAINT "squad_rescue_members_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "squad_rescue_members"
  ADD CONSTRAINT "squad_rescue_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "games" ("id", "name", "status", "max_players", "created_at", "updated_at")
VALUES ('custom', 'Custom', 'coming_soon', 8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "communities" ("id", "name", "external_url", "visit_count", "squads_created", "squads_completed", "created_at", "updated_at")
VALUES ('ffmobilebrasil', 'FF Mobile Brasil', NULL, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
