-- The system_key awards are what resolve_tournament_award falls back to when a
-- placement has no override. Delete one and calculate_tournament_awards starts
-- inserting a NULL award_id, so finishing a tournament fails outright. The
-- delete action already refuses, but guard the table too: a raw SQL delete or a
-- future code path must not be able to break tournament completion.
CREATE OR REPLACE FUNCTION public.tbd_awards() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.system_key IS NOT NULL THEN
        RAISE EXCEPTION 'Built-in award "%" cannot be deleted', OLD.system_key;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_awards ON public.awards;
CREATE TRIGGER tbd_awards
    BEFORE DELETE ON public.awards
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_awards();
