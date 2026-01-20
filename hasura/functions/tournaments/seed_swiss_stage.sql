CREATE OR REPLACE FUNCTION public.seed_swiss_stage(stage_id uuid) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    stage record;
    bracket record;
    team_1_id uuid;
    team_2_id uuid;
    team_1_seed_val int;
    team_2_seed_val int;
    teams_assigned_count int;
BEGIN
    RAISE NOTICE '=== STARTING SWISS STAGE SEEDING ===';
    RAISE NOTICE 'Stage ID: %', stage_id;

    SELECT * INTO stage FROM tournament_stages WHERE id = stage_id;

    IF stage IS NULL THEN
        RAISE EXCEPTION 'Stage % not found', stage_id USING ERRCODE = '22000';
    END IF;

    IF stage.type != 'Swiss' THEN
        RAISE EXCEPTION 'seed_swiss_stage can only be used for Swiss tournament stages' USING ERRCODE = '22000';
    END IF;

    teams_assigned_count := 0;

    RAISE NOTICE '--- Processing Swiss Stage % (groups: %) ---', stage."order", stage.groups;
    
    -- Process first-round brackets for Swiss tournaments
    -- For Swiss: assign teams to first round (round 1, pool 0-0)
    FOR bracket IN 
        SELECT tb.id, tb.round, tb."group", tb.match_number, tb.team_1_seed, tb.team_2_seed
        FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = stage.id
            AND tb.round = 1
            AND tb."group" = 0  -- Swiss filters to group 0 (0-0 pool)
            AND COALESCE(tb.path, 'WB') = 'WB'  -- never seed or mark byes on loser brackets
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

        IF team_1_id IS NOT NULL THEN
            teams_assigned_count := teams_assigned_count + 1;
        END IF;
        
        IF team_2_id IS NOT NULL THEN
            teams_assigned_count := teams_assigned_count + 1;
        END IF;

        -- Update bracket with teams
        -- Swiss should never have byes
        UPDATE tournament_brackets 
        SET tournament_team_id_1 = team_1_id,
            tournament_team_id_2 = team_2_id,
            bye = false
        WHERE id = bracket.id;
        
        RAISE NOTICE '  Swiss Round 1 Pool 0-0 Match %: Seed % (team %) vs Seed % (team %)', 
            bracket.match_number,
            team_1_seed_val, team_1_id,
            team_2_seed_val, team_2_id;
    END LOOP;

    RAISE NOTICE '=== SWISS STAGE SEEDING COMPLETE ===';
    RAISE NOTICE 'Total teams assigned: %', teams_assigned_count;
    
    RETURN;
END;
$$;

