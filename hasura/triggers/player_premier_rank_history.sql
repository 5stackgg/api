CREATE OR REPLACE FUNCTION public.tad_player_premier_rank_history()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    latest RECORD;
BEGIN
    SELECT rank, observed_at
        INTO latest
        FROM public.player_premier_rank_history
        WHERE steam_id = OLD.steam_id
        ORDER BY observed_at DESC
        LIMIT 1;

    IF NOT FOUND THEN
        UPDATE public.players
           SET premier_rank = NULL,
               premier_rank_updated_at = NULL
         WHERE steam_id = OLD.steam_id;
    ELSE
        UPDATE public.players
           SET premier_rank = latest.rank,
               premier_rank_updated_at = latest.observed_at
         WHERE steam_id = OLD.steam_id;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_player_premier_rank_history ON public.player_premier_rank_history;
CREATE TRIGGER tad_player_premier_rank_history
    AFTER DELETE ON public.player_premier_rank_history
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_player_premier_rank_history();
