CREATE OR REPLACE FUNCTION public.delete_tournament_brackets_and_matches(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    tournament_matches uuid[];
BEGIN
    SELECT array_agg(tb.match_id) INTO tournament_matches
    FROM tournament_brackets tb
    JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
    LEFT JOIN match_map_demos mmd ON mmd.match_id = tb.match_id
    WHERE ts.tournament_id = _tournament_id AND mmd.match_id IS NULL;

    DELETE FROM tournament_brackets
        WHERE tournament_stage_id IN (SELECT id FROM tournament_stages WHERE tournament_id = _tournament_id);

    IF tournament_matches IS NOT NULL THEN
        DELETE FROM matches WHERE id = ANY(tournament_matches);
    END IF;
END;
$$ LANGUAGE plpgsql;