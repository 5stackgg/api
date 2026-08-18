CREATE OR REPLACE FUNCTION public.tad_draft_games() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.match_options_id IS NOT NULL THEN
        DELETE FROM public.match_options WHERE id = OLD.match_options_id;
    END IF;
    RETURN OLD;
END;
$$;
