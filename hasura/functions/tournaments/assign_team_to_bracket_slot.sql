CREATE OR REPLACE FUNCTION public.assign_team_to_bracket_slot(
    _target_bracket_id uuid,
    _team_id uuid,
    _source_bracket_id uuid DEFAULT NULL
) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    target_bracket tournament_brackets%ROWTYPE;
    slot_position int;
BEGIN
    -- Lock the target row so concurrent callers (e.g. two feeder matches
    -- finishing simultaneously) serialize on the same bracket. Combined with
    -- the IS NULL guards on the UPDATEs below, this prevents either caller
    -- from overwriting a team the other just placed.
    SELECT * INTO target_bracket
    FROM tournament_brackets
    WHERE id = _target_bracket_id
    FOR UPDATE;

    IF target_bracket IS NULL OR _team_id IS NULL THEN
        RETURN;
    END IF;

    IF target_bracket.tournament_team_id_1 = _team_id
       OR target_bracket.tournament_team_id_2 = _team_id THEN
        RETURN;
    END IF;

    -- Determine the correct slot from feeder ordering:
    -- 1. Loser drops (loser_parent_bracket_id) come before winner feeds (parent_bracket_id)
    -- 2. Within same type, order by round then match_number
    -- This matches the bracket generation layout.
    IF _source_bracket_id IS NOT NULL THEN
        SELECT pos INTO slot_position
        FROM (
            SELECT f.id,
                   row_number() OVER (
                       ORDER BY
                           CASE WHEN f.loser_parent_bracket_id = _target_bracket_id THEN 0 ELSE 1 END,
                           f.round,
                           f.match_number
                   ) AS pos
            FROM tournament_brackets f
            WHERE f.parent_bracket_id = _target_bracket_id
               OR f.loser_parent_bracket_id = _target_bracket_id
        ) ranked
        WHERE ranked.id = _source_bracket_id;
    END IF;

    -- Every UPDATE carries an IS NULL guard as defense-in-depth alongside the
    -- row lock, so a slot can never be overwritten even if a caller bypasses
    -- the lock (e.g. direct mutation outside this function).
    IF slot_position = 1 THEN
        IF target_bracket.tournament_team_id_1 IS NULL THEN
            UPDATE tournament_brackets
            SET tournament_team_id_1 = _team_id
            WHERE id = _target_bracket_id
              AND tournament_team_id_1 IS NULL;
        ELSIF target_bracket.tournament_team_id_2 IS NULL THEN
            UPDATE tournament_brackets
            SET tournament_team_id_2 = _team_id
            WHERE id = _target_bracket_id
              AND tournament_team_id_2 IS NULL;
        END IF;
    ELSIF slot_position = 2 THEN
        IF target_bracket.tournament_team_id_2 IS NULL THEN
            UPDATE tournament_brackets
            SET tournament_team_id_2 = _team_id
            WHERE id = _target_bracket_id
              AND tournament_team_id_2 IS NULL;
        ELSIF target_bracket.tournament_team_id_1 IS NULL THEN
            UPDATE tournament_brackets
            SET tournament_team_id_1 = _team_id
            WHERE id = _target_bracket_id
              AND tournament_team_id_1 IS NULL;
        END IF;
    ELSE
        -- Fallback: first empty slot (for callers without source bracket)
        IF target_bracket.tournament_team_id_1 IS NULL THEN
            UPDATE tournament_brackets
            SET tournament_team_id_1 = _team_id
            WHERE id = _target_bracket_id
              AND tournament_team_id_1 IS NULL;
        ELSIF target_bracket.tournament_team_id_2 IS NULL THEN
            UPDATE tournament_brackets
            SET tournament_team_id_2 = _team_id
            WHERE id = _target_bracket_id
              AND tournament_team_id_2 IS NULL;
        END IF;
    END IF;
END;
$$;
