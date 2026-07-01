-- Deleting a season should untag its ELO rows (they revert to off-season / the
-- global ladder), not be blocked by the FK. player_season_stats already cascades.
ALTER TABLE public.player_elo
    DROP CONSTRAINT IF EXISTS player_elo_season_id_fkey;

ALTER TABLE public.player_elo
    ADD CONSTRAINT player_elo_season_id_fkey
    FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE SET NULL;
