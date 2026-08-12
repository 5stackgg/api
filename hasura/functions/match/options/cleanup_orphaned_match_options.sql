CREATE OR REPLACE FUNCTION public.cleanup_orphaned_match_options(target_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF target_id IS NULL THEN
        RETURN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.matches             WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.tournaments         WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_stages   WHERE match_options_id = target_id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_brackets WHERE match_options_id = target_id)
    THEN
        DELETE FROM public.match_options WHERE id = target_id;
    END IF;
END;
$$;
