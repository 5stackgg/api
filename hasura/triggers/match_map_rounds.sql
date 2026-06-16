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
