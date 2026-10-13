-- Answers what assert_tournament_stages_editable enforces, and the two must
-- agree: Setup is open, RegistrationOpen and CheckInReview are open until a
-- bracket holds a match or a team, and every other status is drawn.
CREATE OR REPLACE FUNCTION public.tournament_is_drawn(_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tournaments t
        WHERE t.id = _tournament_id
          AND t.status != 'Setup'
          AND (
              t.status NOT IN ('RegistrationOpen', 'CheckInReview')
              OR EXISTS (
                  SELECT 1
                  FROM public.tournament_brackets tb
                  JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
                  WHERE ts.tournament_id = t.id
                    AND (
                        tb.match_id IS NOT NULL
                        OR tb.tournament_team_id_1 IS NOT NULL
                        OR tb.tournament_team_id_2 IS NOT NULL
                    )
              )
          )
    );
$$;
