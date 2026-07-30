-- The rating a player was actually judged on: a blend of their own ELO and
-- their team's average (see _individual_weight in get_player_elo_for_match).
--
-- Deliberately not backfilled. Rows written before the blend landed were rated
-- on the team average alone, and recomputing this column from the current
-- function would pair a blended rating with an expected_score that was never
-- derived from it. NULL means "rated on player_team_elo_avg", which is exactly
-- what those rows were.
ALTER TABLE public.player_elo
  ADD COLUMN IF NOT EXISTS rating_for_expected double precision;
