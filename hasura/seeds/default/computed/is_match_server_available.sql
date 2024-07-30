CREATE OR REPLACE FUNCTION public.is_match_server_available(match public.matches) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
 	IF match.server_id IS NULL THEN
        RETURN false;
    END IF;
    RETURN is_server_available(match.server_id, match.id);
END;
$$;