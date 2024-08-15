CREATE OR REPLACE FUNCTION public.get_server_current_match_id(server public.servers) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match_id text;
BEGIN
    SELECT m.id
    INTO match_id
    FROM servers s
    INNER JOIN matches m ON m.server_id = s.id
    WHERE s.id = server.id
    AND m.status = 'Live'
    ORDER BY m.id DESC
    LIMIT 1;
    RETURN match_id;
END;
$$;