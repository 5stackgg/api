CREATE OR REPLACE FUNCTION public.can_schedule_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    lineup_1_ready boolean;
    lineup_2_ready boolean;
BEGIN
    IF (match.status != 'Canceled' AND match.status != 'PickingPlayers' AND match.status != 'Scheduled' AND match.status != 'Surrendered' AND match.status != 'Forfeit') THEN
      return false;
   END IF;


    IF NOT check_match_has_min_players(match) THEN
        RETURN false;
    END IF;


    IF is_match_organizer(match, hasura_session) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;
