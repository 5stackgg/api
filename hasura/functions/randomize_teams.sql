CREATE OR REPLACE FUNCTION public.randomize_teams(match_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    match_status TEXT;
    match_lineup_1_id UUID;
    match_lineup_2_id UUID;
BEGIN
    SELECT status, lineup_1_id, lineup_2_id INTO match_status, match_lineup_1_id, match_lineup_2_id
    FROM matches
    WHERE id = match_id;

    IF match_status != 'PickingPlayers' THEN
        RAISE EXCEPTION 'Match is not picking players' USING ERRCODE = '22000';
    END IF;

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
            END AS new_lineup_id,
            ROW_NUMBER() OVER (PARTITION BY 
                CASE 
                    WHEN rn % 2 = 1 THEN match_lineup_1_id
                    ELSE match_lineup_2_id
                END 
            ORDER BY rn) AS team_rn
        FROM randomized_players
    )
    UPDATE match_lineup_players mlp
    SET 
        match_lineup_id = ta.new_lineup_id,
        captain = CASE WHEN ta.team_rn = 1 THEN true ELSE false END
    FROM team_assignments ta
    WHERE mlp.id = ta.id;
END;
$$;