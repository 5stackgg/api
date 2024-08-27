CREATE OR REPLACE FUNCTION public.get_veto_type(match public.matches) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    bestOf int;
    totalPicks int;
    hasMapVeto boolean;
    vetoPattern VARCHAR[];
    pickType VARCHAR(255);
    available_maps uuid[];
    lastPick match_veto_picks%ROWTYPE;
BEGIN
    select map_veto, best_of into hasMapVeto, bestOf from match_options where id = match.match_options_id;
	IF match.status != 'Veto' OR hasMapVeto = false THEN
	 return NULL;
	END IF;
    vetoPattern = get_veto_pattern(match);
    -- Get the last pick from match_veto_picks table
    SELECT * INTO lastPick FROM match_veto_picks WHERE match_id = match.id ORDER BY created_at DESC LIMIT 1;
    -- Count total picks for the match
    SELECT COUNT(*) INTO totalPicks FROM match_veto_picks WHERE match_id = match.id;
    -- Determine pick type based on match_best_of and totalPicks
    IF bestOf = 1 THEN
        pickType := 'Ban';
    ELSE
        pickType := vetoPattern[totalPicks + 1];
    END IF;
    -- Get available maps for the match
    SELECT array_agg(mp.map_id) INTO available_maps
        FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id
        LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
        LEFT JOIN match_veto_picks mvp ON mvp.match_id = match.id AND mvp.map_id = mp.map_id
        WHERE m.id = match.id
        AND mvp IS NULL;
    -- If only one map is available, set pickType to 'Decider'
    IF pickType != 'Side' AND array_length(available_maps, 1) = 1 THEN
        pickType := 'Decider';
    END IF;
	return pickType;
END
$$;