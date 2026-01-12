CREATE OR REPLACE FUNCTION generate_double_elimination_bracket(
    _stage_id uuid,
    _teams_per_group int,
    _groups int,
    _next_stage_max_teams int
)
RETURNS void AS $$
DECLARE
    P int;
    wb_rounds int;
    lb_rounds int;
    grand_finals_reset boolean;
    g int;
    r int;
    match_num int;
    loser_group_num int;
    wb_match_ids uuid[];
    lb_match_ids uuid[];
    lb_prev_match_ids uuid[];
    wb_match_count int;
    lb_match_count int;
    target_lb_round int;
    i int;
    j int;
    new_id uuid;
    wb_final_id uuid;
    lb_final_id uuid;
    lb_consolidation_id uuid;
    gf_id uuid;
    reset_final_id uuid;
    grand_finals_match_options_id uuid;
    current_round_matches int;
    prev_round_matches int;
BEGIN
    P := POWER(2, CEIL(LOG(_teams_per_group::numeric) / LOG(2)))::int;

    -- Winners bracket rounds
    wb_rounds := LOG(P::numeric) / LOG(2);

    -- Losers bracket rounds (enough for intake/elimination/final)
    lb_rounds := 2 * (wb_rounds - 1);

    --  DE bracket: teams=4, P=4, WB rounds=2, LB rounds=3
    RAISE NOTICE 'DE bracket: teams=%, P=%, WB rounds=%, LB rounds=%',
        _teams_per_group, P, wb_rounds, lb_rounds;

    -- Loop per group
    FOR g IN 1.._groups LOOP
        loser_group_num := g + _groups;
        lb_prev_match_ids := NULL;

        -- Generate LB rounds
        FOR r IN 1..lb_rounds LOOP
            -- Calculate number of matches in this LB round
            IF r = 1 THEN
                lb_match_count := P / 4; -- WB R1 losers, paired 2-at-a-time
            ELSE
                -- Pattern: rounds 1-2 use 2^2, rounds 3-4 use 2^3, rounds 5-6 use 2^4, etc.
                -- Formula: exponent = CEIL((r+2)/2)
                lb_match_count := P / POWER(2, CEIL((r + 2)::numeric / 2)::int);
            END IF;

            RAISE NOTICE 'LB round %: % matches', r, lb_match_count;

            lb_match_ids := ARRAY[]::uuid[];
            FOR match_num IN 1..lb_match_count LOOP
                INSERT INTO tournament_brackets(round, tournament_stage_id, match_number, "group", path)
                VALUES (r, _stage_id, match_num, loser_group_num, 'LB')
                RETURNING id INTO new_id;
                lb_match_ids := lb_match_ids || new_id;
            END LOOP;

            lb_prev_match_ids := lb_match_ids;
        END LOOP;

        -- Link WB losers to LB
        FOR r IN 1..wb_rounds LOOP
            SELECT array_agg(id ORDER BY match_number ASC) INTO wb_match_ids
            FROM tournament_brackets
            WHERE tournament_stage_id = _stage_id AND path='WB' AND round=r AND "group"=g;

            wb_match_count := COALESCE(array_length(wb_match_ids,1),0);
            IF wb_match_count=0 THEN CONTINUE; END IF;

            -- Find LB matches that can still accept WB losers
            -- Count existing feeds into each LB match (from previous WB loser assignments)
            -- A match can accept more feeds if it has fewer than 2 total feeds
            SELECT array_agg(tb.id ORDER BY tb.round ASC, tb.match_number ASC) INTO lb_match_ids
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = _stage_id
              AND tb.path = 'LB'
              AND tb.round >= r
              AND tb."group" = loser_group_num
              AND (
                  -- Count current feeds into this match
                  (SELECT COUNT(*)
                   FROM tournament_brackets feeder
                   WHERE (
                    feeder.loser_parent_bracket_id = tb.id
                    OR feeder.parent_bracket_id = tb.id
                   )) < 2
              );

            lb_match_count := COALESCE(array_length(lb_match_ids,1),0);

            -- If no LB matches available, skip this WB round
            IF lb_match_count = 0 THEN
                CONTINUE;
            END IF;

            -- Assign WB losers to LB matches
            IF r=1 THEN
                -- pair 2-at-a-time
                FOR i IN 1..wb_match_count LOOP
                    j := ((i-1)/2)+1;
                    IF j <= lb_match_count THEN
                        UPDATE tournament_brackets
                        SET loser_parent_bracket_id = lb_match_ids[j]
                        WHERE id = wb_match_ids[i];
                    END IF;
                END LOOP;
            ELSE
                -- 1-to-1 mapping
                FOR i IN 1..LEAST(wb_match_count, lb_match_count) LOOP
                    UPDATE tournament_brackets
                    SET loser_parent_bracket_id = lb_match_ids[i]
                    WHERE id = wb_match_ids[i];
                END LOOP;
            END IF;
        END LOOP;

        -- Create Grand Final / Reset Final if needed
        IF wb_rounds > 0 AND _next_stage_max_teams=1 THEN
            grand_finals_match_options_id := update_match_options_best_of(_stage_id);
        
            -- WB Grand Final
            INSERT INTO tournament_brackets(round, tournament_stage_id, match_number, "group", path, match_options_id)
            VALUES (wb_rounds+1, _stage_id, 1, g, 'WB', grand_finals_match_options_id)
            RETURNING id INTO gf_id;

            SELECT id INTO lb_final_id
            FROM tournament_brackets
            WHERE tournament_stage_id=_stage_id AND path='LB' AND round=lb_rounds AND "group"=loser_group_num
            ORDER BY match_number ASC LIMIT 1;

            UPDATE tournament_brackets
                SET parent_bracket_id = gf_id
                WHERE id = lb_final_id;

            -- -- Reset Final
            -- INSERT INTO tournament_brackets(round, tournament_stage_id, match_number, "group", path)
            --     VALUES (wb_rounds+2, _stage_id, 1, g, 'WB')
            --     RETURNING id INTO reset_final_id;

            RAISE NOTICE 'Group %: LB consolidation round % and WB Grand Final created', g, lb_rounds+1;
        END IF;

    END LOOP;
END;
$$ LANGUAGE plpgsql;