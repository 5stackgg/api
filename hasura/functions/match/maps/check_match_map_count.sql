CREATE OR REPLACE FUNCTION public.check_match_map_count(match_map match_maps) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    match_best_of INTEGER;
	match_maps_count INTEGER;
BEGIN
	SELECT mo.best_of INTO match_best_of FROM matches m
	    inner join match_options mo on mo.id = m.match_options_id
	 WHERE m.id = match_map.match_id;
	SELECT count(*) INTO match_maps_count from match_maps where match_id = match_map.match_id;

	IF (match_maps_count >= match_best_of) THEN
		RAISE EXCEPTION 'Match already has the maximum number of picked maps' USING ERRCODE = '22000';
	END IF;
END;
$$;