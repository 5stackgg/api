DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tournament_teams_creator_steam_id_tournament_id_key'
  ) THEN
    ALTER TABLE "public"."tournament_teams"
      ADD CONSTRAINT "tournament_teams_creator_steam_id_tournament_id_key"
      UNIQUE ("owner_steam_id", "tournament_id");
  END IF;
END $$;
