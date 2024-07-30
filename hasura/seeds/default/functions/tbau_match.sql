CREATE FUNCTION public.tbau_match() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    bracket tournament_brackets;
BEGIN
        RETURN NEW;
END;
$$;