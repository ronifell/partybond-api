-- Squad Rescue: match type vs game mode, extra platforms, mic preference.
-- rescue_platform becomes free text so Switch / cross-play / other do not touch the mobile GamePlatform enum.

ALTER TABLE "sessions" ALTER COLUMN "rescue_platform" TYPE VARCHAR(32) USING "rescue_platform"::text;

ALTER TABLE "sessions" ADD COLUMN "rescue_match_type" VARCHAR(24);
ALTER TABLE "sessions" ADD COLUMN "rescue_game_mode" VARCHAR(60);
ALTER TABLE "sessions" ADD COLUMN "rescue_mic_preference" VARCHAR(16);
