CREATE OR REPLACE FUNCTION public.tai_match_map_rounds_recompute_stats()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Bulk importers recompute once at the end; skip the per-row churn.
  IF current_setting('app.skip_round_recompute', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    PERFORM public.recompute_player_match_map_stats(OLD.match_map_id);
    RETURN OLD;
  ELSE
    PERFORM public.recompute_player_match_map_stats(NEW.match_map_id);
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_map_rounds_recompute_stats ON public.match_map_rounds;
CREATE TRIGGER tai_match_map_rounds_recompute_stats
  AFTER INSERT OR UPDATE OR DELETE ON public.match_map_rounds
  FOR EACH ROW
  EXECUTE FUNCTION public.tai_match_map_rounds_recompute_stats();

-- Keeps match_maps.lineup_1_rounds_won / lineup_2_rounds_won (migration
-- 1890000001390) equal to each map's latest round. Per statement, so a demo
-- import's rounds refresh each map once.
CREATE OR REPLACE FUNCTION public.taiudt_match_map_scores()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        PERFORM public.refresh_match_map_scores(NULL);
    ELSIF TG_OP = 'INSERT' THEN
        PERFORM public.refresh_match_map_scores(ARRAY(SELECT DISTINCT match_map_id FROM new_rows));
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.refresh_match_map_scores(ARRAY(SELECT DISTINCT match_map_id FROM old_rows));
    ELSE
        PERFORM public.refresh_match_map_scores(ARRAY(
            SELECT DISTINCT changed.match_map_id
            FROM (
                (SELECT match_map_id, time, lineup_1_score, lineup_2_score, deleted_at FROM new_rows
                 EXCEPT
                 SELECT match_map_id, time, lineup_1_score, lineup_2_score, deleted_at FROM old_rows)
                UNION
                (SELECT match_map_id, time, lineup_1_score, lineup_2_score, deleted_at FROM old_rows
                 EXCEPT
                 SELECT match_map_id, time, lineup_1_score, lineup_2_score, deleted_at FROM new_rows)
            ) changed
        ));
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_map_scores ON public.match_map_rounds;
CREATE TRIGGER tai_match_map_scores
    AFTER INSERT ON public.match_map_rounds
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiudt_match_map_scores();

DROP TRIGGER IF EXISTS tau_match_map_scores ON public.match_map_rounds;
CREATE TRIGGER tau_match_map_scores
    AFTER UPDATE ON public.match_map_rounds
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiudt_match_map_scores();

DROP TRIGGER IF EXISTS tad_match_map_scores ON public.match_map_rounds;
CREATE TRIGGER tad_match_map_scores
    AFTER DELETE ON public.match_map_rounds
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiudt_match_map_scores();

DROP TRIGGER IF EXISTS tat_match_map_scores ON public.match_map_rounds;
CREATE TRIGGER tat_match_map_scores
    AFTER TRUNCATE ON public.match_map_rounds
    FOR EACH STATEMENT EXECUTE FUNCTION public.taiudt_match_map_scores();
