-- A stage could once hold a map pool of its own. Nothing shows or writes that
-- any more, so a stage still on one differs from its tournament invisibly.
-- Those follow the tournament again, except where the bracket is drawn: its
-- matches were made from the stage's pool, and that pool no longer changes.
--
-- Migrations run before hasura/functions are applied, so this cannot call
-- tournament_is_drawn(); its rule is inlined instead.
UPDATE public.match_options mo
   SET map_pool_id = template.map_pool_id
  FROM public.tournament_stages ts
  JOIN public.tournaments t ON t.id = ts.tournament_id
  JOIN public.match_options template ON template.id = t.match_options_id
 WHERE mo.id = ts.match_options_id
   AND mo.map_pool_id IS DISTINCT FROM template.map_pool_id
   AND (
       t.status = 'Setup'
       OR (
           t.status IN ('RegistrationOpen', 'CheckInReview')
           AND NOT EXISTS (
               SELECT 1
                 FROM public.tournament_brackets tb
                 JOIN public.tournament_stages drawn ON drawn.id = tb.tournament_stage_id
                WHERE drawn.tournament_id = t.id
                  AND (
                      tb.match_id IS NOT NULL
                      OR tb.tournament_team_id_1 IS NOT NULL
                      OR tb.tournament_team_id_2 IS NOT NULL
                  )
           )
       )
   );
