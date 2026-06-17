-- Display freshness mid-series; the decision path recomputes in
-- update_tournament_bracket/seed_stage. Importers can set
-- app.skip_stage_results_recompute = 'on' and call recompute_tournament_results.
CREATE OR REPLACE FUNCTION public.tau_match_maps_stage_results() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    r record;
BEGIN
    IF current_setting('app.skip_stage_results_recompute', true) = 'on' THEN
        RETURN NEW;
    END IF;

    IF OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.winning_lineup_id IS NOT DISTINCT FROM NEW.winning_lineup_id THEN
        RETURN NEW;
    END IF;

    FOR r IN
        SELECT DISTINCT tb.tournament_stage_id
        FROM public.tournament_brackets tb
        WHERE tb.match_id = NEW.match_id
    LOOP
        PERFORM public.recompute_tournament_stage_results(r.tournament_stage_id);
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_maps_stage_results ON public.match_maps;
CREATE TRIGGER tau_match_maps_stage_results
    AFTER UPDATE ON public.match_maps
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_match_maps_stage_results();

-- Backfill stages missing cached rows (full populate on first deploy).
DO $$
DECLARE
    s record;
BEGIN
    FOR s IN
        SELECT ts.id
        FROM public.tournament_stages ts
        WHERE NOT EXISTS (
            SELECT 1 FROM public.v_team_stage_results r
            WHERE r.tournament_stage_id = ts.id
        )
    LOOP
        PERFORM public.recompute_tournament_stage_results(s.id);
    END LOOP;
END $$;
