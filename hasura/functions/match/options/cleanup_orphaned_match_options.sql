CREATE OR REPLACE FUNCTION public.cleanup_orphaned_match_options(target_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF target_id IS NULL THEN
        RETURN;
    END IF;

    -- Every table that points at match_options has to be checked. draft_games,
    -- league_seasons and team_scrim_requests are ON DELETE SET NULL, so deleting
    -- a row still in use silently drops the settings they read back rather than
    -- raising.
    IF NOT EXISTS (SELECT 1 FROM public.matches               WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.tournaments           WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_stages     WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_brackets   WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.draft_games           WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.league_seasons        WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.team_scrim_requests   WHERE match_options_id = target_id)
    THEN
        DELETE FROM public.match_options WHERE id = target_id;
    END IF;
END;
$$;

-- Shared AFTER DELETE trigger for every table that owns a match_options row.
CREATE OR REPLACE FUNCTION public.tad_cleanup_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.cleanup_orphaned_match_options(OLD.match_options_id);
    RETURN OLD;
END;
$$;
