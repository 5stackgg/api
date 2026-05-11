-- Rebuild player_match_map_stats for every map with at least one finalized
-- round. Returns the number of maps recomputed.

CREATE OR REPLACE FUNCTION public.recompute_all_player_match_map_stats(
  notice_every integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  processed integer := 0;
  total     integer;
BEGIN
  SELECT COUNT(DISTINCT match_map_id) INTO total
  FROM public.match_map_rounds;

  RAISE NOTICE 'Recomputing stats for % maps...', total;

  FOR r IN
    SELECT DISTINCT match_map_id
    FROM public.match_map_rounds
    ORDER BY match_map_id
  LOOP
    PERFORM public.recompute_player_match_map_stats(r.match_map_id);
    processed := processed + 1;
    IF notice_every > 0 AND processed % notice_every = 0 THEN
      RAISE NOTICE '  % / % maps done', processed, total;
    END IF;
  END LOOP;

  RAISE NOTICE 'Done. % maps recomputed.', processed;
  RETURN processed;
END;
$$;
