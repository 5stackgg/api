CREATE OR REPLACE FUNCTION public.advance_byes_for_tournament(p_tournament_id uuid) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    bracket record;
    v_parent_bracket_id uuid;
    winner_id uuid;
    first_child_id uuid;
BEGIN
    RAISE NOTICE '--- Resolving byes ---';

    FOR bracket IN
        SELECT tb.id, tb.match_number, tb.tournament_stage_id, tb.parent_bracket_id,
               tb.tournament_team_id_1, tb.tournament_team_id_2
        FROM tournament_brackets tb
        JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
        WHERE ts.tournament_id = p_tournament_id
          AND tb.round = 1
          AND COALESCE(tb.path, 'WB') = 'WB'  -- only resolve byes in winners brackets
          AND (
            (tb.tournament_team_id_1 IS NULL AND tb.tournament_team_id_2 IS NOT NULL) OR
            (tb.tournament_team_id_1 IS NOT NULL AND tb.tournament_team_id_2 IS NULL)
          )
    LOOP
        v_parent_bracket_id := bracket.parent_bracket_id;
        winner_id := COALESCE(bracket.tournament_team_id_1, bracket.tournament_team_id_2);

        IF v_parent_bracket_id IS NULL OR winner_id IS NULL THEN
            CONTINUE;
        END IF;

        -- Determine which child is the 'first' spot by lowest match_number among siblings
        SELECT tb2.id INTO first_child_id
        FROM tournament_brackets tb2
        WHERE tb2.parent_bracket_id = v_parent_bracket_id
        ORDER BY tb2.match_number ASC
        LIMIT 1;

        IF first_child_id = bracket.id THEN
            UPDATE tournament_brackets
            SET tournament_team_id_1 = winner_id
            WHERE id = v_parent_bracket_id;
        ELSE
            UPDATE tournament_brackets
            SET tournament_team_id_2 = winner_id
            WHERE id = v_parent_bracket_id;
        END IF;

        -- Mark the bye bracket as finished so downstream bye resolution
        -- (e.g. LB R1 brackets) can detect that no loser will arrive
        UPDATE tournament_brackets
        SET finished = true
        WHERE id = bracket.id;

        RAISE NOTICE '  Advanced team % from bracket % to parent %', winner_id, bracket.id, v_parent_bracket_id;
    END LOOP;

    -- After all WB byes are resolved, check for dead LB brackets:
    -- brackets with 0 teams where all feeders are finished (e.g. both WB feeders were byes).
    -- Process by round so cascading dead byes propagate correctly.
    DECLARE
        dead_bracket tournament_brackets%ROWTYPE;
    BEGIN
        FOR dead_bracket IN
            SELECT tb.*
            FROM tournament_brackets tb
            JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
            WHERE ts.tournament_id = p_tournament_id
              AND tb.match_id IS NULL
              AND tb.finished = false
              AND tb.tournament_team_id_1 IS NULL
              AND tb.tournament_team_id_2 IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM tournament_brackets child
                  WHERE (child.parent_bracket_id = tb.id OR child.loser_parent_bracket_id = tb.id)
                    AND child.finished = false
              )
              AND EXISTS (
                  SELECT 1 FROM tournament_brackets child
                  WHERE child.parent_bracket_id = tb.id OR child.loser_parent_bracket_id = tb.id
              )
            ORDER BY tb.round, tb.match_number
        LOOP
            RAISE NOTICE '  Resolving dead bracket % (% R%M%)', dead_bracket.id, dead_bracket.path, dead_bracket.round, dead_bracket.match_number;
            PERFORM resolve_bracket_bye(dead_bracket);
        END LOOP;
    END;

    RETURN;
END;
$$;


