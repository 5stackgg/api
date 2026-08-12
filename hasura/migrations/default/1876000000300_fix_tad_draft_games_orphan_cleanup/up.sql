CREATE OR REPLACE FUNCTION public.tad_draft_games() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM cleanup_orphaned_match_options(OLD.match_options_id);
    RETURN OLD;
END;
$$;
