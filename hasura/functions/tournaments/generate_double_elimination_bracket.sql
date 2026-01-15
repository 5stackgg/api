CREATE OR REPLACE FUNCTION generate_double_elimination_bracket(
    _stage_id uuid,
    _teams_per_group int,
    _groups int,
    _next_stage_max_teams int
)
RETURNS void AS $$
DECLARE
    -- Bracket sizing (treat as full power-of-two bracket W)
    W int;             -- Next power of two ≥ teams
    wb_rounds int;
    lb_rounds int;     -- standard DE losers rounds: 2*(wb_rounds-1) (no redundant trailing "self-play" round)

    -- loop counters
    g int;
    r int;

    loser_group_num int;

    -- LB match counts (based on W, not actual teams)
    lb1 int;                 -- LB round 1 match count = W/4
    lb_match_count int;
    divisor int;

    -- WB feeding
    k int;                   -- WB round feeding this LB round (for FEED rounds)

    -- Grand Final
    grand_finals_match_options_id uuid;
    gf_id uuid;
    lb_final_id uuid;
BEGIN
    -- next power of two
    W := POWER(2, CEIL(LOG(_teams_per_group::numeric) / LOG(2)))::int;
    wb_rounds := (LOG(W::numeric) / LOG(2))::int;
    lb_rounds := CASE WHEN wb_rounds <= 1 THEN 0 ELSE 2 * (wb_rounds - 1) END;
    lb1 := GREATEST(W / 4, 1);

    RAISE NOTICE 'DE bracket (simplified): teams=%, W=%, WB rounds=%, LB rounds=%, LB1=%',
        _teams_per_group, W, wb_rounds, lb_rounds, lb1;

    FOR g IN 1.._groups LOOP
        loser_group_num := g + _groups;

        -- Create full LB as if bracket size were W.
        FOR r IN 1..lb_rounds LOOP
            divisor := POWER(2, ((r - 1) / 2))::int;
            lb_match_count := GREATEST(lb1 / divisor, 1);

            INSERT INTO tournament_brackets(round, tournament_stage_id, match_number, "group", path)
            SELECT r, _stage_id, s.match_number, loser_group_num, 'LB'
            FROM (SELECT generate_series(1, lb_match_count) AS match_number) s;

            -- WB -> LB feeding (loser_parent_bracket_id)
            -- - LB R1 takes WB R1 losers (2 WB losers per LB match)
            -- - LB R2, R4, R6, ... takes WB round (r/2 + 1) losers (1 WB loser per LB match)
            IF r = 1 THEN
                k := 1;

                WITH wb_ranked AS (
                    SELECT
                        wb.id,
                        row_number() OVER (ORDER BY wb.match_number ASC) AS wb_pos,
                        count(*) OVER () AS wb_cnt
                    FROM tournament_brackets wb
                    WHERE wb.tournament_stage_id = _stage_id
                      AND wb.path = 'WB'
                      AND wb."group" = g
                      AND wb.round = k
                ),
                lb_round AS (
                    SELECT lb.id, lb.match_number
                    FROM tournament_brackets lb
                    WHERE lb.tournament_stage_id = _stage_id
                      AND lb.path = 'LB'
                      AND lb."group" = loser_group_num
                      AND lb.round = 1
                ),
                params AS (
                    SELECT
                        (SELECT wb_cnt FROM wb_ranked LIMIT 1) AS wb_cnt,
                        LEAST((SELECT wb_cnt FROM wb_ranked LIMIT 1), 2 * lb_match_count) AS capacity
                ),
                wb_selected AS (
                    SELECT
                        w.id AS wb_id,
                        w.wb_pos - (p.wb_cnt - p.capacity) AS sel_pos
                    FROM wb_ranked w
                    CROSS JOIN params p
                    WHERE w.wb_pos > (p.wb_cnt - p.capacity)
                ),
                wb_to_lb AS (
                    SELECT
                        wb_id,
                        -- "snake" mapping (matches real brackets):
                        -- WB round 1 feeds LB matches 1..N, WB round 2 feeds N..1, WB round 3 feeds 1..N, ...
                        CASE
                            WHEN (k % 2) = 0 THEN (lb_match_count - (((sel_pos + 1) / 2)::int) + 1)
                            ELSE (((sel_pos + 1) / 2)::int)
                        END AS lb_match_number
                    FROM wb_selected
                )
                UPDATE tournament_brackets wb
                SET loser_parent_bracket_id = lb.id
                FROM wb_to_lb map
                JOIN lb_round lb ON lb.match_number = map.lb_match_number
                WHERE wb.id = map.wb_id;

            ELSIF r % 2 = 0 THEN
                k := (r / 2) + 1;

                WITH wb_ranked AS (
                    SELECT
                        wb.id,
                        row_number() OVER (ORDER BY wb.match_number ASC) AS wb_pos,
                        count(*) OVER () AS wb_cnt
                    FROM tournament_brackets wb
                    WHERE wb.tournament_stage_id = _stage_id
                      AND wb.path = 'WB'
                      AND wb."group" = g
                      AND wb.round = k
                ),
                lb_round AS (
                    SELECT lb.id, lb.match_number
                    FROM tournament_brackets lb
                    WHERE lb.tournament_stage_id = _stage_id
                      AND lb.path = 'LB'
                      AND lb."group" = loser_group_num
                      AND lb.round = r
                ),
                params AS (
                    SELECT
                        (SELECT wb_cnt FROM wb_ranked LIMIT 1) AS wb_cnt,
                        LEAST((SELECT wb_cnt FROM wb_ranked LIMIT 1), lb_match_count) AS capacity
                ),
                wb_selected AS (
                    SELECT
                        w.id AS wb_id,
                        CASE
                            WHEN (k % 2) = 0 THEN (lb_match_count - (w.wb_pos - (p.wb_cnt - p.capacity)) + 1)
                            ELSE (w.wb_pos - (p.wb_cnt - p.capacity))
                        END AS lb_match_number
                    FROM wb_ranked w
                    CROSS JOIN params p
                    WHERE w.wb_pos > (p.wb_cnt - p.capacity)
                )
                UPDATE tournament_brackets wb
                SET loser_parent_bracket_id = lb.id
                FROM wb_selected map
                JOIN lb_round lb ON lb.match_number = map.lb_match_number
                WHERE wb.id = map.wb_id;
            END IF;
        END LOOP;

        -- Grand Finals: WB winner vs LB winner
        IF wb_rounds > 0 AND _next_stage_max_teams = 1 THEN
            grand_finals_match_options_id := update_match_options_best_of(_stage_id);

            INSERT INTO tournament_brackets(round, tournament_stage_id, match_number, "group", path, match_options_id)
            VALUES (wb_rounds + 1, _stage_id, 1, g, 'WB', grand_finals_match_options_id)
            RETURNING id INTO gf_id;

            IF lb_rounds > 0 THEN
                SELECT id INTO lb_final_id
                FROM tournament_brackets
                WHERE tournament_stage_id = _stage_id
                  AND path = 'LB'
                  AND round = lb_rounds
                  AND "group" = loser_group_num
                ORDER BY match_number ASC
                LIMIT 1;

                IF lb_final_id IS NOT NULL THEN
                    UPDATE tournament_brackets
                    SET parent_bracket_id = gf_id
                    WHERE id = lb_final_id;
                END IF;
            END IF;
        END IF;
    END LOOP;

    PERFORM link_tournament_stage_matches(_stage_id);
 
     -- After linking, WB round-1 byes are deleted by link_tournament_stage_matches().
     -- That can leave some LB round-1 matches with <2 WB feeders (i.e. an effective bye).
     -- For those, rewire any remaining WB loser drop to the LB match's parent, then delete the LB match.
     WITH lb_prune AS (
         SELECT lb.id, lb.parent_bracket_id
         FROM tournament_brackets lb
         LEFT JOIN tournament_brackets wb
           ON wb.loser_parent_bracket_id = lb.id
          AND wb.tournament_stage_id = _stage_id
          AND wb.path = 'WB'
         WHERE lb.tournament_stage_id = _stage_id
           AND lb.path = 'LB'
           AND lb.round = 1
         GROUP BY lb.id, lb.parent_bracket_id
         HAVING COUNT(wb.id) < 2
     )
     UPDATE tournament_brackets wb
     SET loser_parent_bracket_id = p.parent_bracket_id
     FROM lb_prune p
     WHERE wb.loser_parent_bracket_id = p.id
       AND p.parent_bracket_id IS NOT NULL;

     WITH lb_prune AS (
         SELECT lb.id, lb.parent_bracket_id
         FROM tournament_brackets lb
         LEFT JOIN tournament_brackets wb
           ON wb.loser_parent_bracket_id = lb.id
          AND wb.tournament_stage_id = _stage_id
          AND wb.path = 'WB'
         WHERE lb.tournament_stage_id = _stage_id
           AND lb.path = 'LB'
           AND lb.round = 1
         GROUP BY lb.id, lb.parent_bracket_id
         HAVING COUNT(wb.id) < 2
     )
     DELETE FROM tournament_brackets lb
     USING lb_prune p
     WHERE lb.id = p.id;

    delete from tournament_brackets
        where tournament_stage_id = _stage_id
        and round = 1 and path = 'WB' 
        and team_1_seed is null and team_2_seed is null;
END;
$$ LANGUAGE plpgsql;