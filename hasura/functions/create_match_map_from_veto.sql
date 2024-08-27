CREATE OR REPLACE FUNCTION public.create_match_map_from_veto(match_map_veto_pick match_map_veto_picks) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
  lineup_1_id uuid;
  lineup_2_id uuid;
  total_maps int;
  other_side text;
  available_maps uuid[];
  lineup_id uuid;
  _match matches;
BEGIN
  -- Check if the veto type is 'Side'
  IF match_map_veto_pick.type = 'Side' THEN

        -- Retrieve lineup IDs for the match
        SELECT m.lineup_1_id, m.lineup_2_id INTO lineup_1_id, lineup_2_id FROM matches m
            WHERE
                m.id = match_map_veto_pick.match_id
            LIMIT 1;

        -- Count the total number of maps for the match
        SELECT count(*) INTO total_maps FROM match_maps WHERE match_id = match_map_veto_pick.match_id;

        -- Determine the side for each lineup based on the vetoed side
        other_side := CASE WHEN match_map_veto_pick.side = 'CT' THEN 'TERRORIST' ELSE 'CT' END;

        -- Insert the vetoed map into match_maps table
        INSERT INTO match_maps (match_id, map_id, "order", lineup_1_side, lineup_2_side)
            VALUES (match_map_veto_pick.match_id, match_map_veto_pick.map_id, total_maps + 1,
                    CASE WHEN lineup_1_id = match_map_veto_pick.match_lineup_id THEN match_map_veto_pick.side ELSE other_side END,
                    CASE WHEN lineup_2_id = match_map_veto_pick.match_lineup_id THEN match_map_veto_pick.side ELSE other_side END);
   END IF;

   IF match_map_veto_pick.type = 'Pick' THEN
     RETURN;
   END IF;

  -- Retrieve available maps for veto
  SELECT array_agg(mp.map_id) INTO available_maps FROM matches m
      INNER JOIN match_options mo on mo.id = m.match_options_id
      LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
      LEFT JOIN match_map_veto_picks mvp ON mvp.match_id = match_map_veto_pick.match_id AND mvp.map_id = mp.map_id
      WHERE m.id = match_map_veto_pick.match_id
        AND mvp IS NULL;

  -- If only one map is available for veto
  IF array_length(available_maps, 1) = 1 THEN
    -- Retrieve the match details
    SELECT * INTO _match FROM matches WHERE id = match_map_veto_pick.match_id LIMIT 1;

    -- Determine the lineup ID for veto picking
    SELECT * INTO lineup_id FROM get_map_veto_picking_lineup_id(_match);

    -- Insert the leftover map into match_map_veto_picks table
    INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id)
        VALUES (match_map_veto_pick.match_id, 'Decider', lineup_id, available_maps[1]);

    -- Update the total number of maps for the match and insert the leftover map into match_maps
    SELECT count(*) INTO total_maps FROM match_maps WHERE match_id = match_map_veto_pick.match_id;

    INSERT INTO match_maps (match_id, map_id, "order")
        VALUES (match_map_veto_pick.match_id, available_maps[1], total_maps + 1);

 	UPDATE matches
        SET status = 'Live'
        WHERE id = match_map_veto_pick.match_id;
  END IF;

  RETURN;
END;
$$;