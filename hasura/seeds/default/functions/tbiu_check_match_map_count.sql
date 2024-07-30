CREATE OR REPLACE FUNCTION public.tbiu_check_match_map_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_id uuid;
    match_best_of INTEGER;
	match_maps_count INTEGER;
BEGIN
	_match_id := COALESCE(NEW.match_id, OLD.match_id);
	SELECT mo.best_of INTO match_best_of FROM matches m
	    inner join match_options mo on mo.id = m.match_options_id
	 WHERE m.id = _match_id;
	SELECT count(*) INTO match_maps_count from match_maps where match_id = _match_id;
	IF (OLD.match_id IS DISTINCT FROM NEW.match_id AND match_maps_count >= match_best_of) THEN
		RAISE EXCEPTION 'Match already has the maximum number of picked maps' USING ERRCODE = '22000';
	END IF;
    RETURN NEW;
END;
$$;