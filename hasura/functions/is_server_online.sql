CREATE OR REPLACE FUNCTION public.is_server_online(match public.matches)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    is_online BOOLEAN;
BEGIN
    SELECT s.connected
    INTO is_online
    FROM servers s
    WHERE s.id = match.server_id;

    RETURN is_online;
END;
$$;
