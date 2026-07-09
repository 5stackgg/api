CREATE OR REPLACE FUNCTION public.assign_teams_to_swiss_pools(_stage_id uuid, _round int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    pool_record RECORD;
    bracket_record RECORD;
    team_count int;
    matches_needed int;
    match_counter int;
    bracket_order int[];
    i int;
    seed_1_idx int;
    seed_2_idx int;
    team_1_id uuid;
    team_2_id uuid;
    adjacent_team_id uuid;
    used_teams uuid[];
    teams_to_pair uuid[];
    _total int;
    _bye_team uuid;
    _bye_group numeric;
BEGIN
    RAISE NOTICE '=== Assigning Teams to Swiss Pools for Round % ===', _round;

    used_teams := ARRAY[]::uuid[];

    -- Odd field: pull one team out for a bye (a free win) before pairing so the
    -- remaining pools resolve evenly. Prefer a team that has not had a bye yet;
    -- among those, the lowest-ranked (fewest wins, most losses).
    SELECT COALESCE(SUM(p.team_count), 0) INTO _total
    FROM get_swiss_team_pools(_stage_id, used_teams) p;

    IF _total % 2 = 1 THEN
        SELECT vtsr.tournament_team_id,
               (vtsr.wins * 100 + vtsr.losses)
        INTO _bye_team, _bye_group
        FROM v_team_stage_results vtsr
        WHERE vtsr.tournament_stage_id = _stage_id
        ORDER BY
            EXISTS (
                SELECT 1 FROM tournament_brackets b
                WHERE b.tournament_stage_id = _stage_id
                  AND b.bye = true
                  AND b.tournament_team_id_1 = vtsr.tournament_team_id
            ) ASC,
            vtsr.wins ASC, vtsr.losses DESC, vtsr.tournament_team_id ASC
        LIMIT 1;

        IF _bye_team IS NOT NULL THEN
            PERFORM public.create_swiss_bye_bracket(_stage_id, _round, _bye_team, _bye_group);
            used_teams := used_teams || _bye_team;
        END IF;
    END IF;
    
    FOR pool_record IN 
        SELECT * FROM get_swiss_team_pools(_stage_id, used_teams)
        ORDER BY wins DESC, losses ASC
    LOOP
        team_count := pool_record.team_count;
        
        IF team_count = 0 THEN
            CONTINUE;
        END IF;
        
            -- Calculate pool group: wins * 100 + losses
            DECLARE
                pool_group numeric;
            BEGIN
                pool_group := pool_record.wins * 100 + pool_record.losses;
                
                RAISE NOTICE '  Pool %-% (group %): % teams', 
                    pool_record.wins, pool_record.losses, pool_group, team_count;
            
            -- Filter out any teams already used by an earlier pool iteration.
            -- pool_record.team_ids is a stale snapshot from when the outer
            -- FOR...SELECT was materialized (used_teams was empty then), so a
            -- team borrowed by an earlier pool could otherwise be paired twice.
            SELECT COALESCE(array_agg(t), ARRAY[]::uuid[]) INTO teams_to_pair
            FROM unnest(pool_record.team_ids) AS t
            WHERE NOT (t = ANY(used_teams));

            team_count := COALESCE(array_length(teams_to_pair, 1), 0);

            IF team_count = 0 THEN
                CONTINUE;
            END IF;

            -- Handle odd number of teams
            adjacent_team_id := NULL;

            IF team_count % 2 != 0 THEN
                -- Find a team from an adjacent pool
                adjacent_team_id := find_adjacent_swiss_team(_stage_id, pool_record.wins, pool_record.losses, used_teams);
                
                IF adjacent_team_id IS NOT NULL THEN
                    teams_to_pair := teams_to_pair || adjacent_team_id;
                    used_teams := used_teams || adjacent_team_id;
                    RAISE NOTICE '    Borrowed team % from adjacent pool', adjacent_team_id;
                ELSE
                    RAISE EXCEPTION 'Odd number of teams in pool %-% and no adjacent team found', 
                        pool_record.wins, pool_record.losses USING ERRCODE = '22000';
                END IF;
            END IF;
            
            matches_needed := array_length(teams_to_pair, 1) / 2;
            
            -- For Swiss tournaments, use bracket order for pairing
            -- Filter bracket_order to only include valid seed positions (1 to teams_to_pair.length)
            bracket_order := generate_bracket_order(array_length(teams_to_pair, 1));
            DECLARE
                filtered_order int[];
                valid_seed int;
            BEGIN
                filtered_order := ARRAY[]::int[];
                FOREACH valid_seed IN ARRAY bracket_order LOOP
                    IF valid_seed >= 1 AND valid_seed <= array_length(teams_to_pair, 1) THEN
                        filtered_order := filtered_order || valid_seed;
                    END IF;
                END LOOP;
                bracket_order := filtered_order;
            END;
            
            -- Validate we have enough valid seed positions
            IF array_length(bracket_order, 1) < matches_needed * 2 THEN
                RAISE EXCEPTION 'Not enough valid seed positions in bracket order for pool %-% (needed: %, got: %)', 
                    pool_record.wins, pool_record.losses, matches_needed * 2, array_length(bracket_order, 1) USING ERRCODE = '22000';
            END IF;
            
            match_counter := 1;
            FOR i IN 1..matches_needed LOOP
                -- Get seed positions from filtered bracket order
                seed_1_idx := bracket_order[(i - 1) * 2 + 1];
                seed_2_idx := bracket_order[(i - 1) * 2 + 2];
                
                team_1_id := teams_to_pair[seed_1_idx];
                team_2_id := teams_to_pair[seed_2_idx];
                
                -- Validate that teams are not NULL
                IF team_1_id IS NULL OR team_2_id IS NULL THEN
                    RAISE EXCEPTION 'NULL team found in pool %-% at match % (seed_1_idx: %, seed_2_idx: %, teams_to_pair length: %)', 
                        pool_record.wins, pool_record.losses, match_counter, seed_1_idx, seed_2_idx, array_length(teams_to_pair, 1) USING ERRCODE = '22000';
                END IF;
                
                SELECT id INTO bracket_record
                    FROM tournament_brackets
                    WHERE tournament_stage_id = _stage_id
                    AND round = _round
                    AND "group" = pool_group
                    AND match_number = match_counter
                    LIMIT 1;

                -- The pre-generated placeholder count (binomial estimate) can be
                -- short for non-power-of-2 fields; create the bracket on demand
                -- so pairing is authoritative. Surplus empty placeholders are
                -- pruned after the round is fully paired (below).
                IF bracket_record.id IS NULL THEN
                    INSERT INTO tournament_brackets (
                        round, tournament_stage_id, match_number, "group", path,
                        tournament_team_id_1, tournament_team_id_2, bye
                    )
                    VALUES (
                        _round, _stage_id, match_counter, pool_group, 'WB',
                        team_1_id, team_2_id, false
                    );
                ELSE
                    UPDATE tournament_brackets
                        SET tournament_team_id_1 = team_1_id,
                            tournament_team_id_2 = team_2_id,
                            bye = false
                        WHERE id = bracket_record.id;
                END IF;
                
                -- Mark both teams as used to prevent double-assignment
                used_teams := used_teams || team_1_id || team_2_id;
            
                RAISE NOTICE '    Match %: Team % vs Team %', match_counter, team_1_id, team_2_id;
                match_counter := match_counter + 1;
            END LOOP;
        END;
    END LOOP;

    -- Prune surplus empty placeholders so check_swiss_round_complete does not
    -- wait forever on a teamless bracket (the binomial estimate over-allocates
    -- for non-power-of-2 fields).
    DELETE FROM tournament_brackets
    WHERE tournament_stage_id = _stage_id
      AND round = _round
      AND tournament_team_id_1 IS NULL
      AND tournament_team_id_2 IS NULL
      AND COALESCE(bye, false) = false;

    RAISE NOTICE '=== Team Assignment Complete ===';
END;
$$;

