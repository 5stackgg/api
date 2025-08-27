CREATE OR REPLACE FUNCTION public.check_tournament_finished(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    max_round int;
    incomplete_matches int;
BEGIN
    SELECT MAX(tb.round) INTO max_round
    FROM tournament_brackets tb
    INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE ts.tournament_id = _tournament_id;

    SELECT COUNT(*) INTO incomplete_matches
    FROM tournament_brackets tb
    INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    INNER JOIN matches m ON m.id = tb.match_id
    WHERE ts.tournament_id = _tournament_id
      AND tb.round = max_round
      AND m.winning_lineup_id IS NULL;

    IF incomplete_matches = 0 THEN
        UPDATE tournaments
        SET status = 'Finished'
        WHERE id = _tournament_id;
    END IF;
END;
$$;