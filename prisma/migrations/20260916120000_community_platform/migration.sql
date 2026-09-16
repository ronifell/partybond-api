-- Additive: Discord/Facebook platform on Squad Rescue community attribution.

CREATE TYPE "CommunityPlatform" AS ENUM ('discord', 'facebook');

ALTER TABLE "communities" ADD COLUMN "platform" "CommunityPlatform" NOT NULL DEFAULT 'discord';
