-- Returns the tournament_team_id of the team ranked `_rank` (1-indexed) within
-- the given stage group, using the same tiebreaker order as v_team_stage_results.
-- Used by seed_stage to advance per-group qualifiers from a RoundRobin/Swiss
-- stage into the next stage. The team's group is taken from the brackets it
-- appears in for that stage (RoundRobin places each team in exactly one group;
-- Swiss uses a single group).
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
    WITH team_groups AS (
        SELECT team_id, MIN("group") as "group"
        FROM (
            SELECT tb.tournament_team_id_1 as team_id, tb."group"
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = _stage_id
              AND tb.tournament_team_id_1 IS NOT NULL
              AND COALESCE(tb.path, 'WB') = 'WB'
            UNION ALL
            SELECT tb.tournament_team_id_2 as team_id, tb."group"
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = _stage_id
              AND tb.tournament_team_id_2 IS NOT NULL
              AND COALESCE(tb.path, 'WB') = 'WB'
        ) sub
        GROUP BY team_id
    ),
    ranked AS (
        SELECT
            tg.team_id,
            tg."group",
            ROW_NUMBER() OVER (
                PARTITION BY tg."group"
                ORDER BY
                    COALESCE(vtsr.wins, 0) DESC,
                    COALESCE(vtsr.head_to_head_match_wins, 0) DESC,
                    COALESCE(vtsr.head_to_head_rounds_won, 0) DESC,
                    CASE
                        WHEN COALESCE(vtsr.maps_lost, 0) > 0
                        THEN (COALESCE(vtsr.maps_won, 0)::float / vtsr.maps_lost::float)
                        ELSE COALESCE(vtsr.maps_won, 0)::float
                    END DESC,
                    CASE
                        WHEN COALESCE(vtsr.rounds_lost, 0) > 0
                        THEN (COALESCE(vtsr.rounds_won, 0)::float / vtsr.rounds_lost::float)
                        ELSE COALESCE(vtsr.rounds_won, 0)::float
                    END DESC,
                    COALESCE(vtsr.team_kdr, 0) DESC,
                    tg.team_id ASC
            ) as rank_in_group
        FROM team_groups tg
        INNER JOIN tournament_teams tt
            ON tt.id = tg.team_id
            AND tt.eligible_at IS NOT NULL
        LEFT JOIN v_team_stage_results vtsr
            ON vtsr.tournament_team_id = tg.team_id
            AND vtsr.tournament_stage_id = _stage_id
    )
    SELECT team_id INTO result_team_id
    FROM ranked
    WHERE "group" = _group
      AND rank_in_group = _rank;

    RETURN result_team_id;
END;
$$;
