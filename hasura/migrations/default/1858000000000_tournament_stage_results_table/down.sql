-- Revert to a plain view. Source files in hasura/ must also be git-reverted.
DROP TRIGGER IF EXISTS tau_match_maps_stage_results ON public.match_maps;
DROP FUNCTION IF EXISTS public.recompute_tournament_results(uuid);
DROP FUNCTION IF EXISTS public.recompute_tournament_stage_results(uuid);

DROP TABLE IF EXISTS public.v_team_stage_results;

ALTER VIEW IF EXISTS public.v_team_stage_results_compute RENAME TO v_team_stage_results;
