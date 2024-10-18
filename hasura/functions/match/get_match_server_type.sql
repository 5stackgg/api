CREATE OR REPLACE FUNCTION public.get_match_server_type(match public.matches)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    node_id text;
BEGIN
    IF match.server_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT game_server_node_id
	    INTO node_id
	    FROM servers
	    WHERE id = match.server_id;

    IF node_id IS NULL THEN
        RETURN 'Dedicated';
    ELSE
        RETURN 'On Demand';
    END IF;
END
$$;
