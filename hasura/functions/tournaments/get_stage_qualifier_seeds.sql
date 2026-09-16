DROP FUNCTION IF EXISTS public.get_team_at_stage_rank(uuid, int, int);

-- Wildcards rank by win rate, not wins (uneven groups), and never head-to-head (they never met).
CREATE OR REPLACE FUNCTION public.get_stage_qualifier_seeds(
    _stage_id uuid,
    _seeds int
) RETURNS TABLE(seed int, tournament_team_id uuid)
LANGUAGE plpgsql STABLE
AS $$
#variable_conflict use_column
DECLARE
    _groups int;
    _whole_placements int;
BEGIN
    SELECT GREATEST(COALESCE(ts.groups, 1), 1)
    INTO _groups
    FROM tournament_stages ts
    WHERE ts.id = _stage_id;

    _whole_placements := _seeds / _groups;

    RETURN QUERY
    WITH eligible AS (
        SELECT
            vtsr.tournament_team_id,
            vtsr.group_number,
            vtsr.wins,
            vtsr.losses,
            vtsr.maps_won,
            vtsr.maps_lost,
            vtsr.rounds_won,
            vtsr.rounds_lost,
            vtsr.team_kdr,
            tt.seed AS tournament_seed,
            ROW_NUMBER() OVER (
                PARTITION BY vtsr.group_number
                ORDER BY vtsr.rank
            ) AS placement
        FROM v_team_stage_results vtsr
        INNER JOIN tournament_teams tt
            ON tt.id = vtsr.tournament_team_id
            AND tt.eligible_at IS NOT NULL
        WHERE vtsr.tournament_stage_id = _stage_id
    ),
    wildcards AS (
        SELECT
            e.tournament_team_id,
            ROW_NUMBER() OVER (
                ORDER BY
                    e.placement,
                    CASE WHEN e.wins + e.losses > 0
                         THEN e.wins::float / (e.wins + e.losses)
                         ELSE 0
                    END DESC,
                    CASE WHEN e.maps_lost > 0
                         THEN e.maps_won::float / e.maps_lost
                         ELSE e.maps_won::float
                    END DESC,
                    CASE WHEN e.rounds_lost > 0
                         THEN e.rounds_won::float / e.rounds_lost
                         ELSE e.rounds_won::float
                    END DESC,
                    e.team_kdr DESC,
                    e.tournament_seed ASC NULLS LAST,
                    e.tournament_team_id ASC
            ) AS position
        FROM eligible e
        WHERE e.placement > _whole_placements
    )
    SELECT ((e.placement - 1) * _groups + e.group_number)::int, e.tournament_team_id
    FROM eligible e
    WHERE e.placement <= _whole_placements
    UNION ALL
    SELECT (_whole_placements * _groups + w.position)::int, w.tournament_team_id
    FROM wildcards w
    WHERE _whole_placements * _groups + w.position <= _seeds;
END;
$$;
