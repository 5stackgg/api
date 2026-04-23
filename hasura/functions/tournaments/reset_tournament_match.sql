CREATE OR REPLACE FUNCTION public.clear_tournament_bracket_slot_from_feeder(
    _target_bracket_id uuid,
    _source_bracket_id uuid
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    slot_position int;
BEGIN
    SELECT ranked.pos INTO slot_position
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

    IF slot_position = 1 THEN
        UPDATE tournament_brackets
        SET tournament_team_id_1 = NULL
        WHERE id = _target_bracket_id;
    ELSIF slot_position = 2 THEN
        UPDATE tournament_brackets
        SET tournament_team_id_2 = NULL
        WHERE id = _target_bracket_id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_tournament_match(
    _match_id uuid,
    _new_winning_lineup_id uuid DEFAULT NULL,
    _reset_status text DEFAULT 'WaitingForCheckIn',
    _scheduled_at timestamptz DEFAULT NULL
) RETURNS TABLE (
    deleted_match_id uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
    source_bracket tournament_brackets%ROWTYPE;
    source_match matches%ROWTYPE;
    affected_match_id uuid;
    source_tournament_id uuid;
    feeder record;
BEGIN
    IF _reset_status NOT IN ('Setup', 'Scheduled', 'WaitingForCheckIn') THEN
        RAISE EXCEPTION 'reset status must be Setup, Scheduled, or WaitingForCheckIn' USING ERRCODE = '22000';
    END IF;

    SELECT tb.*
    INTO source_bracket
    FROM tournament_brackets tb
    WHERE tb.match_id = _match_id
    LIMIT 1;

    IF source_bracket.id IS NULL THEN
        RAISE EXCEPTION 'match is not linked to a tournament bracket' USING ERRCODE = '22000';
    END IF;

    SELECT ts.tournament_id
    INTO source_tournament_id
    FROM tournament_stages ts
    WHERE ts.id = source_bracket.tournament_stage_id
    LIMIT 1;

    SELECT *
    INTO source_match
    FROM matches
    WHERE id = _match_id
    LIMIT 1;

    IF source_match.id IS NULL THEN
        RAISE EXCEPTION 'match not found' USING ERRCODE = '22000';
    END IF;

    IF source_match.status = 'Live' THEN
        RAISE EXCEPTION 'cannot reset a live match' USING ERRCODE = '22000';
    END IF;

    IF _new_winning_lineup_id IS NOT NULL
       AND _new_winning_lineup_id <> source_match.lineup_1_id
       AND _new_winning_lineup_id <> source_match.lineup_2_id THEN
        RAISE EXCEPTION 'new winner must be one of the source match lineups' USING ERRCODE = '22000';
    END IF;

    -- Clear parent slots contributed by every affected feeder.
    FOR feeder IN
        WITH RECURSIVE chain AS (
            SELECT source_bracket.id AS id
            UNION ALL
            SELECT parent.id
            FROM chain
            JOIN tournament_brackets current_bracket ON current_bracket.id = chain.id
            JOIN tournament_brackets parent
              ON parent.id = current_bracket.parent_bracket_id
              OR parent.id = current_bracket.loser_parent_bracket_id
            WHERE parent.id IS NOT NULL
        ),
        deduped_chain AS (
            SELECT id
            FROM chain
            GROUP BY id
        )
        SELECT child.id AS child_id,
               child.parent_bracket_id,
               child.loser_parent_bracket_id
        FROM tournament_brackets child
        JOIN deduped_chain dc ON dc.id = child.id
    LOOP
        IF feeder.parent_bracket_id IS NOT NULL THEN
            PERFORM clear_tournament_bracket_slot_from_feeder(
                feeder.parent_bracket_id,
                feeder.child_id
            );
        END IF;

        IF feeder.loser_parent_bracket_id IS NOT NULL THEN
            PERFORM clear_tournament_bracket_slot_from_feeder(
                feeder.loser_parent_bracket_id,
                feeder.child_id
            );
        END IF;
    END LOOP;

    -- Delete already-created downstream matches and clear their bracket references.
    FOR affected_match_id IN
        WITH RECURSIVE chain AS (
            SELECT source_bracket.id AS id
            UNION ALL
            SELECT parent.id
            FROM chain
            JOIN tournament_brackets current_bracket ON current_bracket.id = chain.id
            JOIN tournament_brackets parent
              ON parent.id = current_bracket.parent_bracket_id
              OR parent.id = current_bracket.loser_parent_bracket_id
            WHERE parent.id IS NOT NULL
        ),
        deduped_chain AS (
            SELECT id
            FROM chain
            GROUP BY id
        )
        SELECT tb.match_id
        FROM tournament_brackets tb
        JOIN deduped_chain dc ON dc.id = tb.id
        WHERE tb.id <> source_bracket.id
          AND tb.match_id IS NOT NULL
    LOOP
        DELETE FROM matches
        WHERE id = affected_match_id;
        deleted_match_id := affected_match_id;
        RETURN NEXT;
    END LOOP;

    WITH RECURSIVE chain AS (
        SELECT source_bracket.id AS id
        UNION ALL
        SELECT parent.id
        FROM chain
        JOIN tournament_brackets current_bracket ON current_bracket.id = chain.id
        JOIN tournament_brackets parent
          ON parent.id = current_bracket.parent_bracket_id
          OR parent.id = current_bracket.loser_parent_bracket_id
        WHERE parent.id IS NOT NULL
    ),
    deduped_chain AS (
        SELECT id
        FROM chain
        GROUP BY id
    )
    UPDATE tournament_brackets tb
    SET finished = false,
        match_id = CASE WHEN tb.id = source_bracket.id THEN tb.match_id ELSE NULL END
    FROM deduped_chain dc
    WHERE tb.id = dc.id;

    UPDATE matches
    SET winning_lineup_id = NULL,
        status = _reset_status,
        scheduled_at = CASE
            WHEN _new_winning_lineup_id IS NULL AND _reset_status = 'Scheduled' THEN _scheduled_at
            ELSE NULL
        END,
        started_at = NULL,
        ended_at = NULL,
        cancels_at = NULL
    WHERE id = _match_id;

    IF _new_winning_lineup_id IS NOT NULL THEN
        UPDATE matches
        SET winning_lineup_id = _new_winning_lineup_id
        WHERE id = _match_id;
    END IF;

    IF source_tournament_id IS NOT NULL THEN
        UPDATE tournaments
        SET status = 'Live'
        WHERE id = source_tournament_id
          AND status = 'Finished';

        IF FOUND THEN
            -- Rewinding a finished tournament invalidates awarded placements.
            DELETE FROM tournament_trophies
            WHERE tournament_id = source_tournament_id;
        END IF;

    END IF;
END;
$$;
