CREATE OR REPLACE FUNCTION public.assign_team_to_bracket_slot(
    _target_bracket_id uuid,
    _team_id uuid,
    _source_bracket_id uuid DEFAULT NULL
) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    target_bracket tournament_brackets%ROWTYPE;
    source_bracket tournament_brackets%ROWTYPE;
    slot_position int;
BEGIN
    -- Lock the target row so concurrent callers (e.g. two feeder matches
    -- finishing simultaneously) serialize on the same bracket.
    SELECT * INTO target_bracket
    FROM tournament_brackets
    WHERE id = _target_bracket_id
    FOR UPDATE;

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

    -- Slot-aware short-circuit: only return when the team is already in the
    -- CORRECT owned slot. If it's in the wrong slot (e.g. from a prior buggy
    -- placement), fall through and correct it.
    IF _source_bracket_id IS NOT NULL AND slot_position IS NOT NULL THEN
        IF slot_position = 1 AND target_bracket.tournament_team_id_1 = _team_id THEN
            RETURN;
        ELSIF slot_position = 2 AND target_bracket.tournament_team_id_2 = _team_id THEN
            RETURN;
        END IF;
    ELSE
        -- Unowned callers: keep the original "already present in either slot" short-circuit.
        IF target_bracket.tournament_team_id_1 = _team_id
           OR target_bracket.tournament_team_id_2 = _team_id THEN
            RETURN;
        END IF;
    END IF;

    -- Load the feeder row so we can identify which teams belong to this feeder
    -- (needed to clean up stale placements in the wrong slot).
    IF _source_bracket_id IS NOT NULL THEN
        SELECT * INTO source_bracket
        FROM tournament_brackets
        WHERE id = _source_bracket_id;
    END IF;

    IF slot_position = 1 THEN
        -- Clear the OTHER slot if it currently holds a team contributed by
        -- this feeder (cleanup for reassignment or prior buggy placement).
        IF source_bracket.id IS NOT NULL
           AND target_bracket.tournament_team_id_2 IS NOT NULL
           AND target_bracket.tournament_team_id_2 IN (
               source_bracket.tournament_team_id_1,
               source_bracket.tournament_team_id_2
           ) THEN
            UPDATE tournament_brackets
            SET tournament_team_id_2 = NULL
            WHERE id = _target_bracket_id;
        END IF;

        -- Overwrite the owned slot unconditionally. The row lock above
        -- serializes concurrent feeders, so this is safe.
        UPDATE tournament_brackets
        SET tournament_team_id_1 = _team_id
        WHERE id = _target_bracket_id;

    ELSIF slot_position = 2 THEN
        IF source_bracket.id IS NOT NULL
           AND target_bracket.tournament_team_id_1 IS NOT NULL
           AND target_bracket.tournament_team_id_1 IN (
               source_bracket.tournament_team_id_1,
               source_bracket.tournament_team_id_2
           ) THEN
            UPDATE tournament_brackets
            SET tournament_team_id_1 = NULL
            WHERE id = _target_bracket_id;
        END IF;

        UPDATE tournament_brackets
        SET tournament_team_id_2 = _team_id
        WHERE id = _target_bracket_id;

    ELSE
        -- Fallback for callers without a source bracket: first empty slot,
        -- IS NULL guarded as defense-in-depth against concurrent writes.
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
