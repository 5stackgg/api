-- Rewrites these players' players.elo_ratings (all players when NULL) to what
-- compute_player_elo answers now, leaving rows that are already right alone.
CREATE OR REPLACE FUNCTION public.refresh_player_elo_ratings(_steam_ids bigint[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF cardinality(_steam_ids) = 0 THEN
        RETURN;
    END IF;

    UPDATE public.players p
    SET elo_ratings = c.elo
    FROM (
        SELECT steam_id, public.compute_player_elo(steam_id) AS elo
        FROM public.players
        WHERE _steam_ids IS NULL OR steam_id = ANY (_steam_ids)
    ) c
    WHERE p.steam_id = c.steam_id
      AND p.elo_ratings IS DISTINCT FROM c.elo;
END;
$$;

-- The stored ratings depend on whether seasons are on and which season is
-- active. Both can change with no rating written (the toggle, a season edited,
-- a season starting or ending), so when either differs from what the stored
-- ratings were built with, every player is rebuilt. Players never stored are
-- filled in either way. Run every minute by the api and by the settings and
-- seasons triggers.
CREATE OR REPLACE FUNCTION public.refresh_player_elo_ratings_if_stale()
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    _seasons boolean := public.seasons_enabled();
    _season_id uuid := public.get_active_season();
    _basis public.player_elo_ratings_basis;
BEGIN
    SELECT * INTO _basis FROM public.player_elo_ratings_basis FOR UPDATE;

    IF FOUND
       AND _basis.seasons = _seasons
       AND _basis.season_id IS NOT DISTINCT FROM _season_id THEN
        PERFORM public.refresh_player_elo_ratings(ARRAY(
            SELECT steam_id FROM public.players WHERE elo_ratings IS NULL
        ));
        RETURN false;
    END IF;

    INSERT INTO public.player_elo_ratings_basis (seasons, season_id)
    VALUES (_seasons, _season_id)
    ON CONFLICT (id) DO UPDATE
        SET seasons = EXCLUDED.seasons, season_id = EXCLUDED.season_id;

    PERFORM public.refresh_player_elo_ratings(NULL);
    RETURN true;
END;
$$;
