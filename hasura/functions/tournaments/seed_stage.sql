CREATE OR REPLACE FUNCTION public.seed_stage(stage_id uuid) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    stage record;
    previous_stage record;
    bracket record;
    team_record record;
    team_1_id uuid;
    team_2_id uuid;
    team_1_seed_val int;
    team_2_seed_val int;
    teams_assigned_count int;
BEGIN
    RAISE NOTICE '=== STARTING STAGE SEEDING ===';
    RAISE NOTICE 'Stage ID: %', stage_id;

    SELECT * INTO stage FROM tournament_stages WHERE id = stage_id;

    IF stage IS NULL THEN
        RAISE EXCEPTION 'Stage % not found', stage_id;
    END IF;

    SELECT * INTO previous_stage
    FROM tournament_stages
    WHERE tournament_id = stage.tournament_id
      AND "order" = stage."order" - 1;
    
    teams_assigned_count := 0;

    RAISE NOTICE '--- Processing Stage % (groups: %, type: %) ---', stage."order", stage.groups, stage.type;
    
    IF stage.type = 'Swiss' THEN
        -- Process first round brackets which have seed positions set
        FOR bracket IN 
            SELECT tb.id, tb.round, tb."group", tb.match_number, tb.team_1_seed, tb.team_2_seed
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = stage.id
                AND tb.round = 1
                AND COALESCE(tb.path, 'WB') = 'WB'
                AND (tb.team_1_seed IS NOT NULL OR tb.team_2_seed IS NOT NULL)
            ORDER BY tb.match_number ASC
        LOOP
            team_1_id := NULL;
            team_2_id := NULL;
            team_1_seed_val := bracket.team_1_seed;
            team_2_seed_val := bracket.team_2_seed;
            
            -- Find team with matching seed for position 1
            IF team_1_seed_val IS NOT NULL THEN
                SELECT id INTO team_1_id
                FROM tournament_teams
                WHERE tournament_id = stage.tournament_id 
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
                WHERE tournament_id = stage.tournament_id 
                    AND eligible_at IS NOT NULL
                    AND seed = team_2_seed_val
                LIMIT 1;
                
                IF team_2_id IS NOT NULL THEN
                    teams_assigned_count := teams_assigned_count + 1;
                END IF;
            END IF;
            
            -- Update bracket with teams (Swiss should never have byes)
            UPDATE tournament_brackets 
            SET tournament_team_id_1 = team_1_id,
                tournament_team_id_2 = team_2_id,
                bye = false
            WHERE id = bracket.id;
            
            RAISE NOTICE '  Swiss Round 1 Match %: Seed % (team %) vs Seed % (team %)', 
                bracket.match_number,
                team_1_seed_val, team_1_id,
                team_2_seed_val, team_2_id;
        END LOOP;
    ELSIF stage.type = 'RoundRobin' THEN
        -- Process all RoundRobin brackets which have seed positions set
        FOR bracket IN 
            SELECT tb.id, tb.round, tb."group", tb.match_number, tb.team_1_seed, tb.team_2_seed
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = stage.id
                AND COALESCE(tb.path, 'WB') = 'WB'  -- RoundRobin uses WB path
                AND (tb.team_1_seed IS NOT NULL OR tb.team_2_seed IS NOT NULL)
            ORDER BY tb.round ASC, tb."group" ASC, tb.match_number ASC
        LOOP
            team_1_id := NULL;
            team_2_id := NULL;
            team_1_seed_val := bracket.team_1_seed;
            team_2_seed_val := bracket.team_2_seed;
            
            -- Find team with matching seed for position 1
            IF team_1_seed_val IS NOT NULL THEN
                SELECT id INTO team_1_id
                FROM tournament_teams
                WHERE tournament_id = stage.tournament_id 
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
                WHERE tournament_id = stage.tournament_id 
                    AND eligible_at IS NOT NULL
                    AND seed = team_2_seed_val
                LIMIT 1;
                
                IF team_2_id IS NOT NULL THEN
                    teams_assigned_count := teams_assigned_count + 1;
                END IF;
            END IF;
            
            -- Update bracket with teams (RoundRobin matches should never have byes)
            UPDATE tournament_brackets 
            SET tournament_team_id_1 = team_1_id,
                tournament_team_id_2 = team_2_id,
                bye = false
            WHERE id = bracket.id;
            
            RAISE NOTICE '  Round % Group % Bracket %: Seed % (team %) vs Seed % (team %)', 
                bracket.round, bracket."group", bracket.match_number,
                team_1_seed_val, team_1_id,
                team_2_seed_val, team_2_id;
        END LOOP;
    ELSE
        -- Process first-round *winners* brackets which have seed positions set (for elimination brackets)
        FOR bracket IN 
            SELECT tb.id, tb.round, tb."group", tb.match_number, tb.team_1_seed, tb.team_2_seed
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = stage.id
                AND tb.round = 1
                AND COALESCE(tb.path, 'WB') = 'WB'  -- never seed or mark byes on loser brackets
            ORDER BY tb."group" ASC, tb.match_number ASC
        LOOP
            team_1_id := NULL;
            team_2_id := NULL;
            team_1_seed_val := bracket.team_1_seed;
            team_2_seed_val := bracket.team_2_seed;
            
            IF previous_stage.id IS NOT NULL AND (previous_stage.type = 'RoundRobin' OR previous_stage.type = 'Swiss') THEN
                IF team_1_seed_val IS NOT NULL THEN
                    SELECT tournament_team_id INTO team_1_id
                    FROM v_team_stage_results
                    WHERE tournament_stage_id = previous_stage.id
                    OFFSET team_1_seed_val - 1
                    LIMIT 1;
                END IF;

                IF team_2_seed_val IS NOT NULL THEN
                    SELECT tournament_team_id INTO team_2_id
                    FROM v_team_stage_results
                    WHERE tournament_stage_id = previous_stage.id
                    OFFSET team_2_seed_val - 1
                    LIMIT 1;
                END IF;
            ELSE
                -- Find team with matching seed for position 1
                IF team_1_seed_val IS NOT NULL THEN
                    SELECT id INTO team_1_id
                    FROM tournament_teams
                    WHERE tournament_id = stage.tournament_id 
                        AND eligible_at IS NOT NULL
                        AND seed = team_1_seed_val
                    LIMIT 1;
                END IF;
                
                -- Find team with matching seed for position 2
                IF team_2_seed_val IS NOT NULL THEN
                    SELECT id INTO team_2_id
                    FROM tournament_teams
                    WHERE tournament_id = stage.tournament_id 
                        AND eligible_at IS NOT NULL
                        AND seed = team_2_seed_val
                    LIMIT 1;
                END IF;
            END IF;

            IF team_1_id IS NOT NULL THEN
                teams_assigned_count := teams_assigned_count + 1;
            END IF;
            
             IF team_2_id IS NOT NULL THEN
                teams_assigned_count := teams_assigned_count + 1;
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
    END IF;

    IF stage.type != 'RoundRobin' THEN
        PERFORM advance_byes_for_tournament(stage.tournament_id);
    END IF;

    RAISE NOTICE '=== STAGE SEEDING COMPLETE ===';
    RAISE NOTICE 'Total teams assigned: %', teams_assigned_count;
    
    RETURN;
END;
$$;