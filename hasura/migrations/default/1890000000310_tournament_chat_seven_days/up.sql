ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS finished_at timestamptz;

UPDATE public.tournaments t
   SET finished_at = last_match.ended_at
  FROM (
    SELECT ts.tournament_id, max(m.ended_at) AS ended_at
      FROM public.tournament_stages ts
      JOIN public.tournament_brackets tb ON tb.tournament_stage_id = ts.id
      JOIN public.matches m ON m.id = tb.match_id
     GROUP BY ts.tournament_id
  ) last_match
 WHERE last_match.tournament_id = t.id
   AND t.status = 'Finished'
   AND t.finished_at IS NULL;

-- 86400 is what 1877000006000 seeded; any other value is an operator's choice.
UPDATE public.settings
   SET value = '604800'
 WHERE name = 'public.chat_ttl_tournament'
   AND value = '86400';
