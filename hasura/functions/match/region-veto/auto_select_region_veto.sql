CREATE OR REPLACE FUNCTION public.auto_select_region_veto(match_region_veto_pick match_region_veto_picks) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
  _match matches;
  lineup_id uuid;
  has_map_veto BOOLEAN;
  available_regions text[];
BEGIN
    select array_agg(sr.value) INTO available_regions from server_regions sr
        INNER JOIN game_server_nodes gsn on gsn.region = sr.value and gsn.enabled = true
        LEFT JOIN match_region_veto_picks mvp on mvp.region = sr.value and mvp.match_id = match_region_veto_pick.match_id
        where mvp.region is null
        and gsn.is_lan = false;

  IF array_length(available_regions, 1) = 1 THEN
    SELECT * INTO _match FROM matches WHERE id = match_region_veto_pick.match_id LIMIT 1;
    SELECT * INTO lineup_id FROM get_region_veto_picking_lineup_id(_match);

    INSERT INTO match_region_veto_picks (match_id, type, match_lineup_id, region)
        VALUES (match_region_veto_pick.match_id, 'Decider', lineup_id, available_regions[1]);

    UPDATE matches set region = available_regions[1] where id = _match.id;

    SELECT map_veto INTO has_map_veto
      FROM match_options
      WHERE id = _match.match_options_id;

    IF has_map_veto = false THEN
      UPDATE matches set status = 'Live' where id = _match.id;
    END IF;
  END IF;
END;
$$;