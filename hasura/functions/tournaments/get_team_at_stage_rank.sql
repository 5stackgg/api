-- Returns the tournament_team_id of the team ranked `_rank` (1-indexed) within
-- the given stage group, considering only eligible teams (`eligible_at IS NOT
-- NULL`). The tiebreaker chain itself lives in v_team_stage_results so the UI
-- standings and bracket-progression seeding never disagree -- this function
-- just re-ranks within the eligible subset so disqualified teams don't take up
-- a seed slot in the next stage.
CREATE OR REPLACE FUNCTION public.get_team_at_stage_rank(
    _stage_id uuid,
    _group int,
    _rank int
) RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    result_team_id uuid;
BEGIN
    WITH eligible_ranked AS (
        SELECT
            vtsr.tournament_team_id,
            vtsr.group_number,
            ROW_NUMBER() OVER (
                PARTITION BY vtsr.group_number
                ORDER BY vtsr.rank
            ) as eligible_rank
        FROM v_team_stage_results vtsr
        INNER JOIN tournament_teams tt
            ON tt.id = vtsr.tournament_team_id
            AND tt.eligible_at IS NOT NULL
        WHERE vtsr.tournament_stage_id = _stage_id
    )
    SELECT tournament_team_id
    INTO result_team_id
    FROM eligible_ranked
    WHERE group_number = _group
      AND eligible_rank = _rank;

    RETURN result_team_id;
END;
$$;
