-- A season added, moved or removed can change which season is active, and with
-- it every player's stored elo.
CREATE OR REPLACE FUNCTION public.taiud_seasons_player_elo_ratings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM public.refresh_player_elo_ratings_if_stale();
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taiud_seasons_player_elo_ratings ON public.seasons;
CREATE TRIGGER taiud_seasons_player_elo_ratings
    AFTER INSERT OR UPDATE OR DELETE ON public.seasons
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiud_seasons_player_elo_ratings();
