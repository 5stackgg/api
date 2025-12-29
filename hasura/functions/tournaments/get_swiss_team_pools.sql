CREATE OR REPLACE FUNCTION public.get_swiss_team_pools(_stage_id uuid, _exclude_team_ids uuid[] DEFAULT NULL)
RETURNS TABLE(
    wins int,
    losses int,
    team_ids uuid[],
    team_count int
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        vtsr.wins,
        vtsr.losses,
        array_agg(vtsr.tournament_team_id ORDER BY vtsr.tournament_team_id) as team_ids,
        COUNT(*)::int as team_count
    FROM v_team_stage_results vtsr
    WHERE vtsr.tournament_stage_id = _stage_id
      AND vtsr.wins < 3  -- Not yet advanced (3 wins = advance)
      AND vtsr.losses < 3  -- Not yet eliminated (3 losses = eliminate)
      AND (_exclude_team_ids IS NULL OR NOT (vtsr.tournament_team_id = ANY(_exclude_team_ids)))
    GROUP BY vtsr.wins, vtsr.losses
    HAVING COUNT(*) > 0
    ORDER BY vtsr.wins DESC, vtsr.losses ASC;
END;
$$;

