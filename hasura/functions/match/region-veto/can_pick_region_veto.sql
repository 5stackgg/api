CREATE OR REPLACE FUNCTION public.can_pick_region_veto(match_lineup public.match_lineups, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT lineup_is_picking_region_veto(match_lineup)
       AND is_captain_on_lineup(match_lineup, hasura_session);
$$;
