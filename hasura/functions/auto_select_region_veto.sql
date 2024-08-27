CREATE OR REPLACE FUNCTION public.auto_select_region_veto(match_region_veto_pick match_region_veto_picks) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
  _match matches;
  lineup_id uuid;
  available_regions text[];
BEGIN
    select array_agg(gsr.value) INTO available_regions from e_game_server_node_regions gsr
        INNER JOIN game_server_nodes gsn on gsn.region = gsr.value
        LEFT JOIN match_region_veto_picks mvp on mvp.region = gsr.value and mvp.match_id = match_region_veto_pick.match_id
        where mvp.region is null
            and gsn.region != 'Lan';

  IF array_length(available_regions, 1) = 1 THEN
    SELECT * INTO _match FROM matches WHERE id = match_region_veto_pick.match_id LIMIT 1;
    SELECT * INTO lineup_id FROM get_map_veto_picking_lineup_id(_match);

    INSERT INTO match_region_veto_picks (match_id, type, match_lineup_id, region)
        VALUES (match_region_veto_pick.match_id, 'Decider', lineup_id, available_regions[1]);

    UPDATE matches set region = available_regions[1] where id = match_region_veto_pick.match_id;
  END IF;
END;
$$;