CREATE OR REPLACE FUNCTION public.can_reassign_winner(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    bracket_id uuid;
    blocking_downstream int;
BEGIN
    IF NOT is_match_organizer(match, hasura_session) THEN
        RETURN false;
    END IF;

    IF match.status NOT IN ('Finished', 'Tie', 'Canceled', 'Forfeit', 'Surrendered') THEN
        RETURN false;
    END IF;

    SELECT id INTO bracket_id
    FROM tournament_brackets
    WHERE match_id = match.id
    LIMIT 1;

    IF bracket_id IS NULL THEN
        RETURN true;
    END IF;

    SELECT count(*) INTO blocking_downstream
    FROM tournament_brackets tb
    LEFT JOIN matches m ON m.id = tb.match_id
    WHERE (tb.parent_bracket_id = bracket_id OR tb.loser_parent_bracket_id = bracket_id)
      AND m.id IS NOT NULL
      AND m.status NOT IN ('Scheduled', 'WaitingForCheckIn', 'Canceled');

    RETURN blocking_downstream = 0;
END;
$$;
