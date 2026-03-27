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
    SELECT * INTO target_bracket
    FROM tournament_brackets
    WHERE id = _target_bracket_id
    LIMIT 1;

    IF target_bracket IS NULL OR _team_id IS NULL THEN
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

    IF slot_position = 1 THEN
        UPDATE tournament_brackets
        SET tournament_team_id_1 = _team_id
        WHERE id = _target_bracket_id
          AND tournament_team_id_1 IS NULL;
    ELSIF slot_position = 2 THEN
        UPDATE tournament_brackets
        SET tournament_team_id_2 = _team_id
        WHERE id = _target_bracket_id
          AND tournament_team_id_2 IS NULL;
    ELSE
        -- Fallback: first empty slot (for callers without source bracket)
        IF target_bracket.tournament_team_id_1 IS NULL THEN
            UPDATE tournament_brackets
            SET tournament_team_id_1 = _team_id
            WHERE id = _target_bracket_id;
        ELSIF target_bracket.tournament_team_id_2 IS NULL THEN
            UPDATE tournament_brackets
            SET tournament_team_id_2 = _team_id
            WHERE id = _target_bracket_id;
        END IF;
    END IF;
END;
$$;