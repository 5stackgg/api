CREATE OR REPLACE FUNCTION public.seed_tournament(tournament tournaments) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    total_teams int;
    stage record;
    bracket record;
    team_1_id uuid;
    team_2_id uuid;
    team_1_seed_val int;
    team_2_seed_val int;
    teams_assigned_count int;
BEGIN
    PERFORM update_tournament_stages(tournament.id);

    RAISE NOTICE '=== STARTING TOURNAMENT SEEDING ===';
    RAISE NOTICE 'Tournament ID: %', tournament.id;

    SELECT COUNT(*) INTO total_teams
    FROM tournament_teams
    WHERE tournament_id = tournament.id AND eligible_at IS NOT NULL;

    IF total_teams = 0 THEN
        RAISE NOTICE 'No eligible teams found for tournament %', tournament.id;
        RETURN;
    END IF;

    RAISE NOTICE 'Total teams to seed: %', total_teams;
    
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
    
    -- Get count of teams that got seeds assigned
    GET DIAGNOSTICS teams_assigned_count = ROW_COUNT;
    IF teams_assigned_count > 0 THEN
        RAISE NOTICE 'Assigned seeds to % teams based on eligible_at order', teams_assigned_count;
    END IF;
    
    teams_assigned_count := 0;

    -- Process each stage separately
    FOR stage IN 
        SELECT DISTINCT ts.id, ts."order", ts.groups
        FROM tournament_stages ts
        WHERE ts.tournament_id = tournament.id
        ORDER BY ts."order" ASC
    LOOP
        RAISE NOTICE '--- Processing Stage % (groups: %) ---', stage."order", stage.groups;
        
        -- Process first round brackets which have seed positions set
        FOR bracket IN 
            SELECT tb.id, tb.round, tb."group", tb.match_number, tb.team_1_seed, tb.team_2_seed
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = stage.id
              AND tb.round = 1
            ORDER BY tb."group" ASC, tb.match_number ASC
        LOOP
            team_1_id := NULL;
            team_2_id := NULL;
            team_1_seed_val := bracket.team_1_seed;
            team_2_seed_val := bracket.team_2_seed;
            
            -- Find team with matching seed for position 1
            IF team_1_seed_val IS NOT NULL THEN
                SELECT id INTO team_1_id
                FROM tournament_teams
                WHERE tournament_id = tournament.id 
                  AND eligible_at IS NOT NULL
                  AND seed = team_1_seed_val
                LIMIT 1;
                
                IF team_1_id IS NOT NULL THEN
                    teams_assigned_count := teams_assigned_count + 1;
                END IF;
            END IF;
            
            -- Find team with matching seed for position 2
            IF team_2_seed_val IS NOT NULL THEN
                SELECT id INTO team_2_id
                FROM tournament_teams
                WHERE tournament_id = tournament.id 
                  AND eligible_at IS NOT NULL
                  AND seed = team_2_seed_val
                LIMIT 1;
                
                IF team_2_id IS NOT NULL THEN
                    teams_assigned_count := teams_assigned_count + 1;
                END IF;
            END IF;
            
            -- Update bracket with teams
            UPDATE tournament_brackets 
            SET tournament_team_id_1 = team_1_id,
                tournament_team_id_2 = team_2_id,
                bye = (team_1_id IS NULL OR team_2_id IS NULL)
            WHERE id = bracket.id;
            
            RAISE NOTICE '  Bracket %: Seed % (team %) vs Seed % (team %)', 
                bracket.match_number, 
                team_1_seed_val, team_1_id,
                team_2_seed_val, team_2_id;
        END LOOP;
        
        -- Only seed the first stage
        EXIT;
    END LOOP;

    -- Auto-advance bye winners to parent brackets
    PERFORM advance_byes_for_tournament(tournament.id);

    -- Check for byes and log them
    RAISE NOTICE '--- Checking for byes ---';
    FOR bracket IN
        SELECT tb.id, tb.match_number, tb.team_1_seed, tb.team_2_seed, 
               tb.tournament_team_id_1, tb.tournament_team_id_2
        FROM tournament_brackets tb
        JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
        WHERE ts.tournament_id = tournament.id
          AND tb.round = 1
          AND (tb.tournament_team_id_1 IS NULL OR tb.tournament_team_id_2 IS NULL)
        ORDER BY tb.match_number ASC
    LOOP
        IF bracket.tournament_team_id_1 IS NULL AND bracket.tournament_team_id_2 IS NULL THEN
            RAISE NOTICE '  Bracket %: BYE - No teams assigned (seeds: % vs %)', 
                bracket.match_number, bracket.team_1_seed, bracket.team_2_seed;
        ELSIF bracket.tournament_team_id_1 IS NULL THEN
            RAISE NOTICE '  Bracket %: BYE - Team 1 missing (seed %), Team 2 has seed %', 
                bracket.match_number, bracket.team_1_seed, bracket.team_2_seed;
        ELSE
            RAISE NOTICE '  Bracket %: BYE - Team 2 missing (seed %), Team 1 has seed %', 
                bracket.match_number, bracket.team_2_seed, bracket.team_1_seed;
        END IF;
    END LOOP;

    RAISE NOTICE '=== TOURNAMENT SEEDING COMPLETE ===';
    RAISE NOTICE 'Total teams assigned: %', teams_assigned_count;
    
    RETURN;
END;
$$;