-- A stage could once hold a map pool of its own. Nothing shows or writes that
-- any more, so a stage still on one differs from its tournament invisibly.
-- Those follow the tournament again, except where the bracket is drawn: its
-- matches were made from the stage's pool, and that pool no longer changes.
--
-- Migrations run before hasura/functions are applied, so this cannot call
-- tournament_is_drawn(); its rule is inlined instead, and narrowed: a stage
-- with any match behind it stays as it is, in Setup too. The triggers of the
-- release being upgraded from rebuild those matches' maps and refuse an edit
-- behind a finished one, and a repair that fails must never stop the boot.
DO $$
DECLARE
    stage record;
BEGIN
    FOR stage IN
        SELECT mo.id, template.map_pool_id
          FROM public.tournament_stages ts
          JOIN public.tournaments t ON t.id = ts.tournament_id
          JOIN public.match_options template ON template.id = t.match_options_id
          JOIN public.match_options mo ON mo.id = ts.match_options_id
         WHERE mo.map_pool_id IS DISTINCT FROM template.map_pool_id
           AND t.status IN ('Setup', 'RegistrationOpen', 'CheckInReview')
           AND NOT EXISTS (
               SELECT 1 FROM public.matches m WHERE m.match_options_id = mo.id
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM public.tournament_brackets tb
                 JOIN public.tournament_stages drawn ON drawn.id = tb.tournament_stage_id
                WHERE drawn.tournament_id = t.id
                  AND (
                      tb.match_id IS NOT NULL
                      OR (
                          t.status != 'Setup'
                          AND (
                              tb.tournament_team_id_1 IS NOT NULL
                              OR tb.tournament_team_id_2 IS NOT NULL
                          )
                      )
                  )
           )
    LOOP
        BEGIN
            UPDATE public.match_options
               SET map_pool_id = stage.map_pool_id
             WHERE id = stage.id;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Stage options % keep their own map pool: %', stage.id, SQLERRM;
        END;
    END LOOP;
END;
$$;
