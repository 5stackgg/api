CREATE FUNCTION public.is_server_available(match_id uuid, match_server_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM servers s
        INNER JOIN matches m ON m.server_id = s.id
        WHERE s.id = match_server_id AND m.status = 'Live' and m.id != match_id
    ) THEN
        RETURN false;
    END IF;
    RETURN true;
END;
$$;