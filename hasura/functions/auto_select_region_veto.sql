CREATE OR REPLACE FUNCTION public.auto_select_region_veto(match_region_veto_pick match_region_veto_picks) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
  available_regions text[];
BEGIN
select array_agg(mp.gsr.value) INTO available_regions from e_game_server_node_regions gsr
	INNER JOIN game_server_nodes gsn on gsn.region = gsr.value
	LEFT JOIN match_region_veto_picks mvp on mvp.region = gsr.value and mvp.match_id = match_region_veto_pick.match_id
	where mvp.region is null;

  IF array_length(available_regions, 1) = 1 THEN
    INSERT INTO match_region_veto_picks (match_id, type, match_lineup_id, region)
        VALUES (match_map_veto_pick.match_id, 'Decider', lineup_id, available_regions[1]);
  END IF;

  RETURN;
END;
$$;