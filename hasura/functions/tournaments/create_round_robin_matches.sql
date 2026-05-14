-- Can work with either team IDs (for decider matches) or seeds (for initial tournament setup)
CREATE OR REPLACE FUNCTION public.create_round_robin_matches(
    _stage_id uuid,
    _group int,
    _start_round int,
    _team_ids uuid[] DEFAULT NULL,
    _team_seeds int[] DEFAULT NULL,
    _schedule_round_1 boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    team_count int;
    effective_count int;       -- team_count, or team_count + 1 with a phantom slot
    has_phantom boolean;       -- true when team_count is odd
    round_count int;
    matches_per_round int;     -- real matches per round (excludes the phantom pair)

    round_num int;
    k int;
    rotated_idx int;
    rotation_offset int;
    rotated_positions int[];
    pos1 int;
    pos2 int;
    match_idx int;
    team_1_id uuid;
    team_2_id uuid;
    team_1_seed int;
    team_2_seed int;
    bracket_record tournament_brackets%ROWTYPE;
    use_team_ids boolean;
BEGIN
    -- Determine if we're using team IDs or seeds
    IF _team_ids IS NOT NULL AND array_length(_team_ids, 1) > 0 THEN
        use_team_ids := true;
        team_count := array_length(_team_ids, 1);
    ELSIF _team_seeds IS NOT NULL AND array_length(_team_seeds, 1) > 0 THEN
        use_team_ids := false;
        team_count := array_length(_team_seeds, 1);
    ELSE
        RAISE EXCEPTION 'Need either team_ids or team_seeds array' USING ERRCODE = '22000';
    END IF;

    IF team_count < 2 THEN
        RAISE EXCEPTION 'Need at least 2 teams for round robin, got %', team_count USING ERRCODE = '22000';
    END IF;

    -- Circle method: with N (even) slots, rotate slots 2..N around the fixed
    -- slot 1 and pair across. For odd team counts we add a phantom slot at the
    -- end; the team paired with the phantom that round is the one that sits
    -- out, which is the only way to guarantee every team plays every other
    -- exactly once with no duplicates.
    IF team_count % 2 = 0 THEN
        effective_count := team_count;
        has_phantom := false;
        matches_per_round := team_count / 2;
    ELSE
        effective_count := team_count + 1;
        has_phantom := true;
        matches_per_round := (team_count - 1) / 2;
    END IF;
    round_count := effective_count - 1;

    RAISE NOTICE 'Creating round robin matches for % teams: % rounds, % matches per round, starting at round %',
        team_count, round_count, matches_per_round, _start_round;

    FOR round_num IN 1..round_count LOOP
        -- Build slot positions for this round. Slot 1 is fixed; slots
        -- 2..effective_count rotate. Cycling over (effective_count - 1)
        -- guarantees each round is unique.
        rotation_offset := (round_num - 1) % (effective_count - 1);

        rotated_positions := ARRAY[1]::int[];
        FOR k IN 1..(effective_count - 1) LOOP
            rotated_idx := ((k - 1 + rotation_offset) % (effective_count - 1)) + 2;
            rotated_positions := rotated_positions || rotated_idx;
        END LOOP;

        match_idx := 0;
        FOR k IN 1..(effective_count / 2) LOOP
            pos1 := rotated_positions[k];
            pos2 := rotated_positions[effective_count + 1 - k];

            -- The phantom occupies slot (team_count + 1); whichever real team
            -- is paired with it that round gets the bye, so emit no bracket.
            IF has_phantom AND (pos1 > team_count OR pos2 > team_count) THEN
                CONTINUE;
            END IF;

            match_idx := match_idx + 1;

            IF use_team_ids THEN
                team_1_id := _team_ids[pos1];
                team_2_id := _team_ids[pos2];

                SELECT COALESCE(seed, 999999) INTO team_1_seed
                FROM tournament_teams
                WHERE id = team_1_id;

                SELECT COALESCE(seed, 999999) INTO team_2_seed
                FROM tournament_teams
                WHERE id = team_2_id;
            ELSE
                team_1_seed := _team_seeds[pos1];
                team_2_seed := _team_seeds[pos2];
                team_1_id := NULL;
                team_2_id := NULL;
            END IF;

            INSERT INTO tournament_brackets (
                round,
                tournament_stage_id,
                match_number,
                "group",
                team_1_seed,
                team_2_seed,
                path,
                tournament_team_id_1,
                tournament_team_id_2
            )
            VALUES (
                _start_round + round_num - 1,
                _stage_id,
                match_idx,
                _group,
                team_1_seed,
                team_2_seed,
                'WB',
                team_1_id,
                team_2_id
            );

            IF use_team_ids THEN
                RAISE NOTICE 'Created match %: round %, team % vs team %',
                    match_idx, _start_round + round_num - 1, team_1_id, team_2_id;
            ELSE
                RAISE NOTICE 'Created match %: round %, seed % vs seed %',
                    match_idx, _start_round + round_num - 1, team_1_seed, team_2_seed;
            END IF;
        END LOOP;
    END LOOP;

    -- Schedule round 1 matches immediately if requested (only for decider matches with team IDs)
    IF _schedule_round_1 AND use_team_ids THEN
        FOR bracket_record IN
            SELECT * FROM tournament_brackets
            WHERE tournament_stage_id = _stage_id
              AND round = _start_round
              AND "group" = _group
              AND match_id IS NULL
              AND tournament_team_id_1 IS NOT NULL
              AND tournament_team_id_2 IS NOT NULL
        LOOP
            PERFORM schedule_tournament_match(bracket_record);
            RAISE NOTICE 'Scheduled round % match: bracket %', _start_round, bracket_record.id;
        END LOOP;
    END IF;

    RAISE NOTICE 'Created % round robin matches starting at round %', round_count * matches_per_round, _start_round;
END;
$$;
