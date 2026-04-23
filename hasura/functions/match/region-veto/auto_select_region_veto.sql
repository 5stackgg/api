CREATE OR REPLACE FUNCTION public.auto_select_region_veto(match_region_veto_pick match_region_veto_picks) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
  _match matches;
  lineup_id uuid;
  has_map_veto BOOLEAN;
  available_regions text[];
  regions text[];
BEGIN
    SELECT * INTO _match FROM matches WHERE id = match_region_veto_pick.match_id LIMIT 1;

    SELECT sanitize_match_options_regions(_match.match_options_id) INTO regions;

    SELECT array_agg(r) INTO available_regions
    FROM unnest(regions) AS r
    WHERE NOT EXISTS (
      SELECT 1
      FROM match_region_veto_picks mvp
      WHERE mvp.match_id = match_region_veto_pick.match_id
      AND lower(mvp.region) = lower(r)
    );

  IF array_length(available_regions, 1) = 1 THEN
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