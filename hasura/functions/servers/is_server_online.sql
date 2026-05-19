CREATE OR REPLACE FUNCTION public.is_server_online(match public.matches)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT s.connected
    FROM servers s
    WHERE s.id = match.server_id;
$$;
