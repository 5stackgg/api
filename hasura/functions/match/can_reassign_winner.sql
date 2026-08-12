CREATE OR REPLACE FUNCTION public.can_reassign_winner(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _parent_bracket_id uuid;
    _loser_parent_bracket_id uuid;
    blocking_downstream int;
BEGIN
    IF NOT is_match_organizer(match, hasura_session) THEN
        RETURN false;
    END IF;

    IF match.status NOT IN ('Finished', 'Tie', 'Canceled', 'Forfeit', 'Surrendered') THEN
        RETURN false;
    END IF;

    SELECT parent_bracket_id, loser_parent_bracket_id
    INTO _parent_bracket_id, _loser_parent_bracket_id
    FROM tournament_brackets
    WHERE match_id = match.id
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN true;
    END IF;

    -- These point *forward*: they are the bracket(s) this match's winner and
    -- loser advance into (see update_tournament_bracket.sql, which assigns the
    -- winning team INTO parent_bracket_id). Matching on tb.parent_bracket_id =
    -- this bracket would instead find the matches feeding IN to it, which are
    -- always already played, and so never blocked anything.
    SELECT count(*) INTO blocking_downstream
    FROM tournament_brackets tb
    LEFT JOIN matches m ON m.id = tb.match_id
    WHERE tb.id IN (_parent_bracket_id, _loser_parent_bracket_id)
      AND m.id IS NOT NULL
      AND m.status NOT IN ('Scheduled', 'WaitingForCheckIn', 'Canceled');

    RETURN blocking_downstream = 0;
END;
$$;
