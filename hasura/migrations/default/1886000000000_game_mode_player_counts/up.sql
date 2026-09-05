-- A mode's team size. NULL means "inherit the match type's count", which is what
-- every mode created before this migration does, so nothing changes for them.
-- Capped at 5 because a CS2 team has five slots and match_lineup_players is
-- sized off the same number.
ALTER TABLE "public"."game_modes"
    ADD COLUMN IF NOT EXISTS "players_per_team" integer;

-- Whether a draft lobby running this mode may start before both sides are full.
-- Defaults off so an existing mode can never start short-handed by accident.
ALTER TABLE "public"."game_modes"
    ADD COLUMN IF NOT EXISTS "allow_short_handed_start" boolean NOT NULL DEFAULT false;

DO $$
BEGIN
    ALTER TABLE "public"."game_modes"
        ADD CONSTRAINT "game_modes_players_per_team_check"
            CHECK ("players_per_team" IS NULL OR "players_per_team" BETWEEN 1 AND 5);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

-- The size a match actually launched at, written only when a lobby force-starts
-- short-handed. Snapshotted rather than resolved live so editing the mode later
-- cannot retroactively invalidate a match that is already running. NULL falls
-- back to the mode, then to the match type.
ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "min_players_per_lineup" integer;
