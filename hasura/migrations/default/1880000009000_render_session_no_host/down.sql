-- Only reversible if no NULL hosts exist (render sessions leave them behind).
ALTER TABLE "public"."utility_practice_sessions"
    ALTER COLUMN "host_steam_id" SET NOT NULL;
