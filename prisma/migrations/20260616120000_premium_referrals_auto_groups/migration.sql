-- Premium subscriptions, referrals, and automatic group formation.
-- Safe to apply idempotently: uses IF NOT EXISTS / DO blocks where appropriate
-- to match the style of earlier migrations in this project.

-- =============================================================================
-- Enums
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "SubscriptionPlatform" AS ENUM ('google_play', 'app_store', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'trial', 'grace', 'on_hold', 'paused', 'canceled', 'expired', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReferralStatus" AS ENUM ('pending', 'registered', 'rewarded', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AutoGroupRequestStatus" AS ENUM ('searching', 'ready', 'fulfilled', 'expired', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- AlterTable: users (premium cache + redeemed referral code)
-- =============================================================================

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "premium_until"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "referred_by_code" TEXT;

-- =============================================================================
-- AlterTable: groups (flag for auto-formed squads)
-- =============================================================================

ALTER TABLE "groups"
  ADD COLUMN IF NOT EXISTS "is_auto_formed" BOOLEAN NOT NULL DEFAULT false;

-- =============================================================================
-- CreateTable: subscriptions
-- =============================================================================

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id"                  TEXT NOT NULL,
  "user_id"             TEXT NOT NULL,
  "platform"            "SubscriptionPlatform" NOT NULL,
  "product_id"          TEXT NOT NULL,
  "purchase_token"      TEXT NOT NULL,
  "original_order_id"   TEXT,
  "status"              "SubscriptionStatus" NOT NULL DEFAULT 'active',
  "auto_renewing"       BOOLEAN NOT NULL DEFAULT true,
  "started_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "current_period_end"  TIMESTAMP(3) NOT NULL,
  "canceled_at"         TIMESTAMP(3),
  "raw_payload"         JSONB,
  "last_verified_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_platform_purchase_token_key"
  ON "subscriptions" ("platform", "purchase_token");

CREATE INDEX IF NOT EXISTS "subscriptions_user_id_status_idx"
  ON "subscriptions" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "subscriptions_current_period_end_idx"
  ON "subscriptions" ("current_period_end");

DO $$ BEGIN
  ALTER TABLE "subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- CreateTable: referral_codes
-- =============================================================================

CREATE TABLE IF NOT EXISTS "referral_codes" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "code"       TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_user_id_key"
  ON "referral_codes" ("user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "referral_codes_code_key"
  ON "referral_codes" ("code");

DO $$ BEGIN
  ALTER TABLE "referral_codes"
    ADD CONSTRAINT "referral_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- CreateTable: referrals
-- =============================================================================

CREATE TABLE IF NOT EXISTS "referrals" (
  "id"                 TEXT NOT NULL,
  "inviter_id"         TEXT NOT NULL,
  "invitee_id"         TEXT,
  "code"               TEXT NOT NULL,
  "status"             "ReferralStatus" NOT NULL DEFAULT 'pending',
  "reward_days"        INTEGER NOT NULL DEFAULT 0,
  "reward_granted_at"  TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "referrals_invitee_id_key"
  ON "referrals" ("invitee_id");

CREATE INDEX IF NOT EXISTS "referrals_inviter_id_status_idx"
  ON "referrals" ("inviter_id", "status");

CREATE INDEX IF NOT EXISTS "referrals_code_idx"
  ON "referrals" ("code");

DO $$ BEGIN
  ALTER TABLE "referrals"
    ADD CONSTRAINT "referrals_inviter_id_fkey"
    FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "referrals"
    ADD CONSTRAINT "referrals_invitee_id_fkey"
    FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- CreateTable: auto_group_requests
-- =============================================================================

CREATE TABLE IF NOT EXISTS "auto_group_requests" (
  "id"             TEXT NOT NULL,
  "user_id"        TEXT NOT NULL,
  "group_id"       TEXT NOT NULL,
  "game_id"        TEXT NOT NULL,
  "game_mode"      "SessionMode" NOT NULL,
  "play_style"     "PlayStyle" NOT NULL,
  "skill_tier"     "SessionSkillTier" NOT NULL,
  "players_needed" INTEGER NOT NULL,
  "min_age"        INTEGER,
  "max_age"        INTEGER,
  "status"         "AutoGroupRequestStatus" NOT NULL DEFAULT 'searching',
  "expires_at"     TIMESTAMP(3) NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "auto_group_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "auto_group_requests_group_id_key"
  ON "auto_group_requests" ("group_id");

CREATE INDEX IF NOT EXISTS "auto_group_requests_status_expires_at_idx"
  ON "auto_group_requests" ("status", "expires_at");

CREATE INDEX IF NOT EXISTS "auto_group_requests_user_id_status_idx"
  ON "auto_group_requests" ("user_id", "status");

DO $$ BEGIN
  ALTER TABLE "auto_group_requests"
    ADD CONSTRAINT "auto_group_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "auto_group_requests"
    ADD CONSTRAINT "auto_group_requests_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
