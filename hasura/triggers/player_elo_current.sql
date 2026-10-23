-- Keeps player_elo_current (migration 1890000001240) equal to what each
-- player's player_elo rows say. Per statement, so a season backfill or a
-- rebuild refreshes each player once rather than once per row.
CREATE OR REPLACE FUNCTION public.taiudt_player_elo_current()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        DELETE FROM public.player_elo_current;
    ELSIF TG_OP = 'INSERT' THEN
        PERFORM public.refresh_player_elo_current(ARRAY(SELECT DISTINCT steam_id FROM new_rows));
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.refresh_player_elo_current(ARRAY(SELECT DISTINCT steam_id FROM old_rows));
    ELSE
        PERFORM public.refresh_player_elo_current(ARRAY(
            SELECT DISTINCT changed.steam_id
            FROM (
                (SELECT steam_id, match_id, "type", "current", created_at, season_id, is_tournament FROM new_rows
                 EXCEPT
                 SELECT steam_id, match_id, "type", "current", created_at, season_id, is_tournament FROM old_rows)
                UNION
                (SELECT steam_id, match_id, "type", "current", created_at, season_id, is_tournament FROM old_rows
                 EXCEPT
                 SELECT steam_id, match_id, "type", "current", created_at, season_id, is_tournament FROM new_rows)
            ) changed
        ));
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_player_elo_current ON public.player_elo;
CREATE TRIGGER tai_player_elo_current
    AFTER INSERT ON public.player_elo
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiudt_player_elo_current();

DROP TRIGGER IF EXISTS tau_player_elo_current ON public.player_elo;
CREATE TRIGGER tau_player_elo_current
    AFTER UPDATE ON public.player_elo
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiudt_player_elo_current();

DROP TRIGGER IF EXISTS tad_player_elo_current ON public.player_elo;
CREATE TRIGGER tad_player_elo_current
    AFTER DELETE ON public.player_elo
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiudt_player_elo_current();

DROP TRIGGER IF EXISTS tat_player_elo_current ON public.player_elo;
CREATE TRIGGER tat_player_elo_current
    AFTER TRUNCATE ON public.player_elo
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiudt_player_elo_current();

-- A voided match's ratings stop counting, and count again when it is restored.
CREATE OR REPLACE FUNCTION public.tau_matches_player_elo_current()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM public.refresh_player_elo_current(ARRAY(
        SELECT DISTINCT pe.steam_id FROM public.player_elo pe WHERE pe.match_id = NEW.id
    ));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_matches_player_elo_current ON public.matches;
CREATE TRIGGER tau_matches_player_elo_current
    AFTER UPDATE OF elo_voided ON public.matches
    FOR EACH ROW
    WHEN (OLD.elo_voided IS DISTINCT FROM NEW.elo_voided)
    EXECUTE FUNCTION public.tau_matches_player_elo_current();
