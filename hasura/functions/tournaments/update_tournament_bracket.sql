CREATE OR REPLACE FUNCTION public.update_tournament_bracket(match matches) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    bracket tournament_brackets%ROWTYPE;
    winning_team_id UUID;
    losing_team_id UUID;
    tournament_id UUID;
    stage_type text;
BEGIN
    IF match.winning_lineup_id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO bracket
    FROM tournament_brackets
    WHERE match_id = match.id
    LIMIT 1;

    IF bracket IS NULL THEN
        RETURN;
    END IF;

    -- Serialize result processing per stage. Two matches reported at the same
    -- moment otherwise interleave row locks in opposite orders (own bracket ->
    -- shared parent -> standings cache -> start-time sweep) and deadlock;
    -- Postgres then aborts one transaction and that match result is lost.
    -- Locking the stage row first gives every reporter the same lock order.
    PERFORM 1 FROM tournament_stages
    WHERE id = bracket.tournament_stage_id
    FOR UPDATE;

    IF match.winning_lineup_id = match.lineup_1_id THEN
        winning_team_id = bracket.tournament_team_id_1;
        losing_team_id = bracket.tournament_team_id_2;
    ELSE
        winning_team_id = bracket.tournament_team_id_2;
        losing_team_id = bracket.tournament_team_id_1;
    END IF;

    update tournament_brackets
    SET finished = true
    WHERE id = bracket.id;

    IF bracket.parent_bracket_id IS NOT NULL THEN
        PERFORM public.assign_team_to_bracket_slot(bracket.parent_bracket_id, winning_team_id, bracket.id);
    END IF;

    IF bracket.loser_parent_bracket_id IS NOT NULL THEN
        PERFORM public.assign_team_to_bracket_slot(bracket.loser_parent_bracket_id, losing_team_id, bracket.id);
    END IF;

    SELECT ts.tournament_id, ts.type INTO tournament_id, stage_type
    FROM tournament_stages ts
    WHERE ts.id = bracket.tournament_stage_id;

    -- Refresh cached standings before advancement/seeding/trophies read them.
    PERFORM public.recompute_tournament_stage_results(bracket.tournament_stage_id);

    IF tournament_id IS NOT NULL THEN
        IF stage_type = 'RoundRobin' THEN
            PERFORM schedule_next_round_robin_matches(bracket.id);
            
            IF check_round_robin_stage_complete(bracket.tournament_stage_id) THEN
                PERFORM advance_round_robin_teams(bracket.tournament_stage_id);
            END IF;
        ELSIF stage_type = 'Swiss' THEN
            IF check_swiss_round_complete(bracket.tournament_stage_id, bracket.round) THEN
                RAISE NOTICE 'Swiss round % complete, assigning teams to next round pools', bracket.round;

                PERFORM advance_swiss_teams(bracket.tournament_stage_id);

                -- Only pair the next round when it actually exists. A no-elim
                -- group keeps every team active, so without this guard the final
                -- round would try to pair a non-existent round+1 and raise.
                IF EXISTS (
                    SELECT 1 FROM tournament_brackets
                    WHERE tournament_stage_id = bracket.tournament_stage_id
                      AND round = bracket.round + 1
                ) THEN
                    PERFORM assign_teams_to_swiss_pools(bracket.tournament_stage_id, bracket.round + 1);
                END IF;
            END IF;
        END IF;
        
        PERFORM check_tournament_finished(tournament_id);
    END IF;

    RETURN;
END;
$$;