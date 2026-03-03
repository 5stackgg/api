CREATE OR REPLACE FUNCTION public.resume_tournament(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    bracket_row tournament_brackets%ROWTYPE;
    _tournament_status text;
BEGIN
    SELECT status INTO _tournament_status FROM tournaments WHERE id = _tournament_id;

    IF _tournament_status != 'Paused' THEN
        RAISE EXCEPTION 'Tournament is not paused' USING ERRCODE = '22000';
    END IF;

    -- Set status back to Live
    UPDATE tournaments SET status = 'Live' WHERE id = _tournament_id;

    -- Schedule all ready brackets that were blocked during pause
    FOR bracket_row IN
        SELECT tb.*
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
          AND tb.match_id IS NULL
          AND tb.finished = false
          AND tb.tournament_team_id_1 IS NOT NULL
          AND tb.tournament_team_id_2 IS NOT NULL
        ORDER BY tb.round, tb.match_number
    LOOP
        PERFORM schedule_tournament_match(bracket_row);
    END LOOP;

    -- Recalculate ETAs
    PERFORM calculate_tournament_bracket_start_times(_tournament_id);
END;
$$;
