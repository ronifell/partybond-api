-- Add device/platform preference to progressive matchmaking queue entries.

CREATE TYPE "GamePlatform" AS ENUM ('playstation', 'xbox', 'pc', 'mobile');

ALTER TABLE "global_queue_entries"
  ADD COLUMN "platform" "GamePlatform" NOT NULL DEFAULT 'mobile';
