CREATE OR REPLACE FUNCTION public.get_map_veto_type(match public.matches) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    bestOf int;
    totalPicks int;
    hasMapVeto boolean;
    vetoPattern VARCHAR[];
    pickType VARCHAR(255);
    available_maps uuid[];
BEGIN
    select map_veto, best_of into hasMapVeto, bestOf from match_options where id = match.match_options_id;

	IF match.status != 'Veto' OR hasMapVeto = false THEN
	 return NULL;
	END IF;

    vetoPattern = get_map_veto_pattern(match);

    SELECT COUNT(*) INTO totalPicks FROM match_map_veto_picks WHERE match_id = match.id;

    -- Determine pick type based on match_best_of and totalPicks
    IF bestOf = 1 THEN
        pickType := 'Ban';
    ELSE
        pickType := vetoPattern[totalPicks + 1];
    END IF;

    return pickType;
END
$$;