CREATE OR REPLACE FUNCTION public.is_match_server_available(match public.matches)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT match.server_id IS NOT NULL
       AND is_server_available(match.server_id, match.id);
$$;
