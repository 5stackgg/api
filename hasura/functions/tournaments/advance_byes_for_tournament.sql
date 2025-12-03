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

        RAISE NOTICE '  Advanced team % from bracket % to parent %', winner_id, bracket.id, v_parent_bracket_id;
    END LOOP;

    RETURN;
END;
$$;


