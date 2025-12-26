CREATE OR REPLACE FUNCTION public.assign_seeds_to_teams(tournament tournaments) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    stage record;
    max_existing_seed int;
BEGIN
    WITH max_existing_seed AS (
        SELECT COALESCE(MAX(seed), 0) as max_seed
        FROM tournament_teams
        WHERE tournament_id = tournament.id 
          AND eligible_at IS NOT NULL
    ),
    teams_to_seed AS (
        SELECT id,
               mes.max_seed + ROW_NUMBER() OVER (ORDER BY eligible_at) as assigned_seed
        FROM tournament_teams
        CROSS JOIN max_existing_seed mes
        WHERE tournament_id = tournament.id 
          AND eligible_at IS NOT NULL
          AND seed IS NULL
    )
    UPDATE tournament_teams tt
    SET seed = tts.assigned_seed
    FROM teams_to_seed tts
    WHERE tt.id = tts.id;
END;
$$;