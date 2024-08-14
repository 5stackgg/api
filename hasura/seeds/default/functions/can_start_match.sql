CREATE OR REPLACE FUNCTION public.can_start_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    lineup_1_ready boolean;
    lineup_2_ready boolean;
BEGIN
    IF (match.status != 'PickingPlayers' AND match.status != 'Scheduled') THEN
       return false;
    END IF;

    IF hasura_session ->> 'x-hasura-role' != 'user' AND is_match_organizer(match, hasura_session) THEN
        RETURN true;
    END IF;

    SELECT is_match_lineup_ready(ml1)
      INTO lineup_1_ready
      FROM match_lineups ml1
      WHERE ml1.id = match.lineup_1_id;

    SELECT is_match_lineup_ready(ml2)
      INTO lineup_2_ready
      FROM match_lineups ml2
      WHERE ml2.id = match.lineup_2_id;

    IF lineup_1_ready AND lineup_2_ready THEN
      RETURN true;
    END IF;

    RETURN false;
END;
$$;
