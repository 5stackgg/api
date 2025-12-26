CREATE OR REPLACE FUNCTION public.delete_tournament_brackets_and_matches(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    tournament_matches uuid[];
BEGIN
   DELETE FROM matches
   WHERE id IN (
       SELECT tb.match_id
       FROM tournament_brackets tb
       JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
       WHERE ts.tournament_id = _tournament_id
         AND tb.match_id IS NOT NULL
   );

   DELETE FROM tournament_brackets
   WHERE tournament_stage_id IN (
       SELECT ts.id
       FROM tournament_stages ts
       WHERE ts.tournament_id = _tournament_id
   );
END;
$$ LANGUAGE plpgsql;