CREATE OR REPLACE FUNCTION public.can_pick_veto(match_lineup public.match_lineups, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
      IF lineup_is_picking_veto(match_lineup) AND is_on_lineup(match_lineup, hasura_session) THEN
        return true;
      END IF;

      return false;
END;
$$;
