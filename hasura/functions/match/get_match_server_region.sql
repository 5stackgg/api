CREATE OR REPLACE FUNCTION public.get_match_server_region(match public.matches)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    region text;
BEGIN
    IF match.server_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT sr.description
	    INTO region
	    FROM servers s
	        INNER JOIN game_server_nodes gsn on gsn.id = s.game_server_node_id
	        INNER JOIN server_regions sr on sr.value = gsn.region
	    WHERE s.id = match.server_id;

	return region;
END
$$;
