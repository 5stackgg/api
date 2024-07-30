CREATE OR REPLACE FUNCTION public.lineup_1_score(match_map public.match_maps) RETURNS integer
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    score int = 0;
BEGIN
    select lineup_1_score into score from match_map_rounds mmr
    where mmr.match_map_id = match_map.id
	order by time desc
	limit 1;
  IF score IS NULL THEN
        score := 0;
    END IF;
	return score;
END;
$$;

CREATE OR REPLACE FUNCTION public.lineup_2_score(match_map public.match_maps) RETURNS integer
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    score int;
BEGIN
    select lineup_2_score into score from match_map_rounds mmr
    where mmr.match_map_id = match_map.id
	order by time desc
	limit 1;
  IF score IS NULL THEN
        score := 0;
    END IF;
	return score;
END;
$$;