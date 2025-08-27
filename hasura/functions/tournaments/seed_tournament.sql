CREATE OR REPLACE FUNCTION public.seed_tournament(tournament tournaments) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    available_teams uuid[];
    total_teams int;
    required_matches int;
    stage record;
    bracket record;
    teams_assigned int;
    team_1_id uuid;
    team_2_id uuid;
BEGIN
    -- Update tournament stages first to ensure all brackets are created
    PERFORM update_tournament_stages(tournament.id);

    RAISE NOTICE '=== STARTING TOURNAMENT SEEDING ===';
    RAISE NOTICE 'Tournament ID: %', tournament.id;

    -- Get eligible teams ordered by seed
    SELECT array_agg(id ORDER BY seed ASC, eligible_at NULLS LAST) INTO available_teams
    FROM tournament_teams
    WHERE tournament_id = tournament.id AND eligible_at IS NOT NULL;

    total_teams := COALESCE(array_length(available_teams, 1), 0);

    IF total_teams = 0 THEN
        RAISE NOTICE 'No eligible teams found for tournament %', tournament.id;
        RETURN;
    END IF;

    -- Calculate required matches (teams/2 rounded up)
    required_matches := CEIL(total_teams::float / 2);
    
    -- Initialize teams_assigned
    teams_assigned := 0;
    
    RAISE NOTICE 'Total teams to seed: %', total_teams;
    RAISE NOTICE 'Required matches: %', required_matches;

    -- Process each stage separately
    FOR stage IN 
        SELECT DISTINCT ts.id, ts."order", ts.groups
        FROM tournament_stages ts
        WHERE ts.tournament_id = tournament.id
        ORDER BY ts."order" ASC
    LOOP
        RAISE NOTICE '--- Processing Stage % (groups: %) ---', stage."order", stage.groups;
        
        FOR bracket IN 
            SELECT tb.id, tb.round, tb."group", tb.match_number
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = stage.id
              AND tb.match_number <= required_matches
            ORDER BY tb.match_number ASC
            LIMIT required_matches
        LOOP
            -- Break if we've assigned all teams
            IF teams_assigned >= total_teams THEN
                EXIT;
            END IF;
            
            team_1_id := available_teams[teams_assigned + 1];
            team_2_id := available_teams[teams_assigned + 2];
            
            UPDATE tournament_brackets 
            SET tournament_team_id_1 = team_1_id,
                tournament_team_id_2 = team_2_id,
                bye = tournament_team_id_2 IS NULL
            WHERE id = bracket.id;
            
            IF team_1_id IS NOT NULL THEN
                teams_assigned := teams_assigned + 1;
            END IF;
            
            IF team_2_id IS NOT NULL THEN
                teams_assigned := teams_assigned + 1;
            END IF;
        END LOOP;
        
        IF teams_assigned >= total_teams THEN
            EXIT;
        END IF;
    END LOOP;

    RAISE NOTICE '=== TOURNAMENT SEEDING COMPLETE ===';
    RAISE NOTICE 'Total teams assigned: %', COALESCE(teams_assigned, 0);
    
    RETURN;
END;
$$;