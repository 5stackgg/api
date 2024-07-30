CREATE FUNCTION public.create_match_map_from_veto() RETURNS trigger
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
  IF NEW.type = 'Side' THEN
        -- Retrieve lineup IDs for the match
        SELECT m.lineup_1_id, m.lineup_2_id INTO lineup_1_id, lineup_2_id
        FROM matches m
        WHERE m.id = NEW.match_id
        LIMIT 1;
        -- Count the total number of maps for the match
        SELECT count(*) INTO total_maps FROM match_maps WHERE match_id = NEW.match_id;
        -- Determine the side for each lineup based on the vetoed side
        other_side := CASE WHEN NEW.side = 'CT' THEN 'TERRORIST' ELSE 'CT' END;
        -- Insert the vetoed map into match_maps table
        INSERT INTO match_maps (match_id, map_id, "order", lineup_1_side, lineup_2_side)
            VALUES (NEW.match_id, NEW.map_id, total_maps + 1,
                    CASE WHEN lineup_1_id = NEW.match_lineup_id THEN NEW.side ELSE other_side END,
                    CASE WHEN lineup_2_id = NEW.match_lineup_id THEN NEW.side ELSE other_side END);
   END IF;
   IF NEW.type = 'Pick' THEN
     RETURN NEW;
   END IF;
  -- Retrieve available maps for veto
  SELECT array_agg(mp.map_id) INTO available_maps
  FROM matches m
  INNER JOIN match_options mo on mo.id = m.match_options_id
  LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
  LEFT JOIN match_veto_picks mvp ON mvp.match_id = NEW.match_id AND mvp.map_id = mp.map_id
  WHERE m.id = NEW.match_id
  AND mvp IS NULL;
  -- If only one map is available for veto
  IF array_length(available_maps, 1) = 1 THEN
    -- Retrieve the match details
    SELECT * INTO _match FROM matches WHERE id = NEW.match_id LIMIT 1;
    -- Determine the lineup ID for veto picking
    SELECT * INTO lineup_id FROM get_veto_picking_lineup_id(_match);
    -- Insert the leftover map into match_veto_picks table
    INSERT INTO match_veto_picks (match_id, type, match_lineup_id, map_id)
    VALUES (NEW.match_id, 'Decider', lineup_id, available_maps[1]);
    -- Update the total number of maps for the match and insert the leftover map into match_maps
    SELECT count(*) INTO total_maps FROM match_maps WHERE match_id = NEW.match_id;
    INSERT INTO match_maps (match_id, map_id, "order")
    VALUES (NEW.match_id, available_maps[1], total_maps + 1);
 	UPDATE matches
    SET status = 'Live'
    WHERE id = NEW.match_id;
  END IF;
  RETURN NEW;
END;
$$;