-- Deleting a system_key award makes calculate_tournament_awards insert a NULL
-- award_id, so finishing a tournament fails outright.
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
