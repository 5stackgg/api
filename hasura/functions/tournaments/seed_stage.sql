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
        RAISE EXCEPTION 'Stage % not found', stage_id USING ERRCODE = '22000';
    END IF;

    SELECT * INTO previous_stage
    FROM tournament_stages
    WHERE tournament_id = stage.tournament_id
      AND "order" = stage."order" - 1;
    
    teams_assigned_count := 0;

    RAISE NOTICE '--- Processing Stage % (groups: %, type: %) ---', stage."order", stage.groups, stage.type;
    
    IF stage.type = 'RoundRobin' THEN
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
    ELSIF stage.type = 'Swiss' THEN
        -- Delegate Swiss seeding to dedicated function
        PERFORM public.seed_swiss_stage(stage_id);
        RETURN;
    ELSE
        -- Process first-round brackets for elimination tournaments
        -- For elimination: process first-round winners brackets
        FOR bracket IN 
            SELECT tb.id, tb.round, tb."group", tb.match_number, tb.team_1_seed, tb.team_2_seed
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = stage.id
                AND COALESCE(tb.path, 'WB') = 'WB'  -- never seed or mark byes on loser brackets
                AND (tb.team_1_seed IS NOT NULL OR tb.team_2_seed IS NOT NULL)
            ORDER BY tb."group" ASC, tb.match_number ASC
        LOOP
            team_1_id := NULL;
            team_2_id := NULL;
            team_1_seed_val := bracket.team_1_seed;
            team_2_seed_val := bracket.team_2_seed;
            
            -- For elimination brackets coming from RoundRobin/Swiss stages, use stage results
            -- Otherwise, lookup teams by seed
            IF previous_stage.id IS NOT NULL AND (previous_stage.type = 'RoundRobin' OR previous_stage.type = 'Swiss') THEN
                -- Map next-stage seed N to (group, rank_in_group) of the previous
                -- stage so groups cross-seed: with G groups, seed 1 = top of group 1,
                -- seed 2 = top of group 2, seed G+1 = 2nd of group 1, and so on.
                -- Falls back to a single group for Swiss (or RR with groups = 1),
                -- which degenerates to plain top-N ordering.
                DECLARE
                    prev_groups int;
                    group_idx int;
                    rank_in_group int;
                BEGIN
                    prev_groups := GREATEST(COALESCE(previous_stage.groups, 1), 1);

                    IF team_1_seed_val IS NOT NULL THEN
                        group_idx := ((team_1_seed_val - 1) % prev_groups) + 1;
                        rank_in_group := ((team_1_seed_val - 1) / prev_groups) + 1;
                        team_1_id := get_team_at_stage_rank(previous_stage.id, group_idx, rank_in_group);
                    END IF;

                    IF team_2_seed_val IS NOT NULL THEN
                        group_idx := ((team_2_seed_val - 1) % prev_groups) + 1;
                        rank_in_group := ((team_2_seed_val - 1) / prev_groups) + 1;
                        team_2_id := get_team_at_stage_rank(previous_stage.id, group_idx, rank_in_group);
                    END IF;
                END;
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
            -- Elimination brackets can have byes
            UPDATE tournament_brackets 
            SET tournament_team_id_1 = team_1_id,
                tournament_team_id_2 = team_2_id
            WHERE id = bracket.id;
            
            RAISE NOTICE '  Bracket %: Seed % (team %) vs Seed % (team %)', 
                bracket.match_number, 
                team_1_seed_val, team_1_id,
                team_2_seed_val, team_2_id;
        END LOOP;

        update tournament_brackets set bye = (tournament_team_id_1 IS NULL OR tournament_team_id_2 IS NULL)
              where tournament_stage_id = stage.id and round = 1 and COALESCE(path, 'WB') = 'WB';
    END IF;

    IF stage.type != 'RoundRobin' THEN
        PERFORM advance_byes_for_tournament(stage.tournament_id);
    END IF;

    RAISE NOTICE '=== STAGE SEEDING COMPLETE ===';
    RAISE NOTICE 'Total teams assigned: %', teams_assigned_count;
    
    RETURN;
END;
$$;