-- Refresh the cached standings for one stage. plpgsql so the compute view
-- (loaded after functions) is resolved at execution, not CREATE.
CREATE OR REPLACE FUNCTION public.recompute_tournament_stage_results(p_stage_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public.v_team_stage_results
    WHERE tournament_stage_id = p_stage_id;

    -- Explicit columns (not SELECT *) so a view column reorder can't corrupt the cache.
    INSERT INTO public.v_team_stage_results (
        tournament_team_id,
        tournament_stage_id,
        matches_played,
        matches_remaining,
        wins,
        losses,
        maps_won,
        maps_lost,
        rounds_won,
        rounds_lost,
        total_kills,
        total_deaths,
        team_kdr,
        head_to_head_match_wins,
        head_to_head_rounds_won,
        group_number,
        rank,
        placement
    )
    SELECT
        tournament_team_id,
        tournament_stage_id,
        matches_played,
        matches_remaining,
        wins,
        losses,
        maps_won,
        maps_lost,
        rounds_won,
        rounds_lost,
        total_kills,
        total_deaths,
        team_kdr,
        head_to_head_match_wins,
        head_to_head_rounds_won,
        group_number,
        rank,
        placement
    FROM public.v_team_stage_results_compute
    WHERE tournament_stage_id = p_stage_id;
END;
$$;

-- Refresh every stage of a tournament (for bulk importers).
CREATE OR REPLACE FUNCTION public.recompute_tournament_results(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    s record;
BEGIN
    FOR s IN
        SELECT id FROM public.tournament_stages WHERE tournament_id = p_tournament_id
    LOOP
        PERFORM public.recompute_tournament_stage_results(s.id);
    END LOOP;
END;
$$;
