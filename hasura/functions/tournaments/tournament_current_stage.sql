-- The stage order a viewer should land on: the earliest stage still holding a
-- match to play, else the furthest stage teams reached, else the first stage.
CREATE OR REPLACE FUNCTION public.tournament_current_stage(tournament public.tournaments)
RETURNS integer
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        (
            SELECT min(ts."order")
              FROM tournament_stages ts
              INNER JOIN tournament_brackets tb ON tb.tournament_stage_id = ts.id
             WHERE ts.tournament_id = tournament.id
               AND tb.finished = false
               AND tb.bye = false
               AND (tb.tournament_team_id_1 IS NOT NULL OR tb.tournament_team_id_2 IS NOT NULL)
        ),
        (
            SELECT max(ts."order")
              FROM tournament_stages ts
              INNER JOIN tournament_brackets tb ON tb.tournament_stage_id = ts.id
             WHERE ts.tournament_id = tournament.id
               AND (tb.tournament_team_id_1 IS NOT NULL OR tb.tournament_team_id_2 IS NOT NULL)
        ),
        (
            SELECT min(ts."order")
              FROM tournament_stages ts
             WHERE ts.tournament_id = tournament.id
        )
    );
$$;
