CREATE OR REPLACE FUNCTION public.tournament_has_min_teams(tournament public.tournaments)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    total_teams int := 0;
    tournament_min_teams int := 0;
BEGIN
   SELECT ts.min_teams, COUNT(tt.*)
       INTO tournament_min_teams, total_teams
       FROM tournament_stages ts
       INNER JOIN tournament_teams tt
       ON tt.tournament_id = ts.tournament_id
       WHERE ts.tournament_id = tournament.id
       GROUP BY ts.min_teams
       LIMIT 1;

   IF NOT FOUND THEN
       RETURN FALSE;
   END IF;

   RETURN tournament_min_teams <= total_teams;
END;
$$;
