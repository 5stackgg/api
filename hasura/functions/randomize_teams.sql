CREATE OR REPLACE FUNCTION public.randomize_teams(match_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    match_lineup_1_id UUID;
    match_lineup_2_id UUID;
BEGIN
    SELECT lineup_1_id, lineup_2_id INTO match_lineup_1_id, match_lineup_2_id
    FROM matches
    WHERE id = match_id;

    WITH randomized_players AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
        FROM match_lineup_players
        WHERE match_lineup_id = match_lineup_1_id OR match_lineup_id = match_lineup_2_id
    ),
    team_assignments AS (
        SELECT 
            id,
            CASE 
                WHEN rn % 2 = 1 THEN match_lineup_1_id
                ELSE match_lineup_2_id
            END AS new_lineup_id
        FROM randomized_players
    )
    
    UPDATE match_lineup_players mlp
    SET match_lineup_id = ta.new_lineup_id
    FROM team_assignments ta
    WHERE mlp.id = ta.id;
END;
$$;