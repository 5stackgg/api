ALTER TABLE public.player_elo
    DROP CONSTRAINT IF EXISTS player_elo_season_id_fkey;

ALTER TABLE public.player_elo
    ADD CONSTRAINT player_elo_season_id_fkey
    FOREIGN KEY (season_id) REFERENCES public.seasons(id);
