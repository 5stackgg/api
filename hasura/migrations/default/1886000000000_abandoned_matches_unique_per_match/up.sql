-- One abandon per player per match. The plugin re-arms its disconnect timer on
-- every disconnect and on every map of a series, so the same leave can report
-- itself several times, and sanction_policy_occurrences() counts rows: each
-- duplicate moved the player a rung up the escalating cooldown ladder for a
-- single offense.
--
-- match_id stays nullable (historical rows, and no-shows recorded before a
-- match exists), and postgres treats NULLs as distinct, so those rows are
-- unaffected by the constraint.
DELETE FROM public.abandoned_matches a
      USING public.abandoned_matches b
      WHERE a.match_id IS NOT NULL
        AND a.match_id = b.match_id
        AND a.steam_id = b.steam_id
        AND (a.abandoned_at, a.id) > (b.abandoned_at, b.id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'abandoned_matches_steam_id_match_id_key'
  ) THEN
    ALTER TABLE "public"."abandoned_matches"
      ADD CONSTRAINT "abandoned_matches_steam_id_match_id_key"
      UNIQUE ("steam_id", "match_id");
  END IF;
END $$;
