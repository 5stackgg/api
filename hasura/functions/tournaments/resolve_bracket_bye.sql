-- Detects and resolves "runtime byes" in elimination brackets.
-- A runtime bye occurs when a bracket receives exactly one team but has
-- no remaining feeder brackets that could provide the second team.
-- This happens in double-elimination losers brackets after LB R1 pruning:
-- the pruned LB R1 match can no longer feed its parent LB R2 bracket,
-- so the WB loser that drops into LB R2 has no opponent.
CREATE OR REPLACE FUNCTION public.resolve_bracket_bye(
    _bracket tournament_brackets
) RETURNS boolean
    LANGUAGE plpgsql
AS $$
DECLARE
    current_bracket tournament_brackets%ROWTYPE;
    pending_feeders int;
    lone_team_id uuid;
    tournament_id uuid;
BEGIN
    -- Re-read from disk: the passed-in row may be stale when called from
    -- a resume loop where earlier iterations cascaded and already resolved this bracket.
    SELECT * INTO current_bracket
    FROM tournament_brackets WHERE id = _bracket.id;

    IF current_bracket IS NULL THEN
        RETURN false;
    END IF;

    -- Both teams present: nothing to resolve
    IF (current_bracket.tournament_team_id_1 IS NOT NULL AND current_bracket.tournament_team_id_2 IS NOT NULL) THEN
        RETURN false;
    END IF;

    IF current_bracket.finished = true OR current_bracket.match_id IS NOT NULL THEN
        RETURN false;
    END IF;

    -- Check if any feeders can still provide a team.
    SELECT COUNT(*) INTO pending_feeders
    FROM tournament_brackets child
    WHERE (child.parent_bracket_id = current_bracket.id
           OR child.loser_parent_bracket_id = current_bracket.id)
      AND child.finished = false;

    IF pending_feeders > 0 THEN
        RETURN false;
    END IF;

    -- A non-NULL team_N_seed on this row means link_tournament_stage_matches()
    -- promoted a bye-advanced seed into this slot and deleted its feeder bracket.
    -- The paired feeder is live and will (or already did) fill the other slot via
    -- assign_team_to_bracket_slot — so this is a real match, not a runtime bye.
    -- Leave the row alone rather than marking it finished.
    IF current_bracket.team_1_seed IS NOT NULL
       OR current_bracket.team_2_seed IS NOT NULL THEN
        RETURN false;
    END IF;

    lone_team_id := COALESCE(current_bracket.tournament_team_id_1, current_bracket.tournament_team_id_2);

    -- Mark as bye and finished
    UPDATE tournament_brackets
    SET bye = true, finished = true
    WHERE id = current_bracket.id;

    IF lone_team_id IS NOT NULL THEN
        -- Runtime bye: one team, no pending feeders → advance
        RAISE NOTICE 'Resolving runtime bye: bracket %, team % advanced to parent %',
            current_bracket.id, lone_team_id, current_bracket.parent_bracket_id;

        IF current_bracket.parent_bracket_id IS NOT NULL THEN
            PERFORM public.assign_team_to_bracket_slot(current_bracket.parent_bracket_id, lone_team_id, current_bracket.id);
        END IF;

        -- A bye produces no loser. Check if the loser_parent bracket is now
        -- a dead bracket (0 teams, all feeders finished).
        IF current_bracket.loser_parent_bracket_id IS NOT NULL THEN
            DECLARE
                loser_target tournament_brackets%ROWTYPE;
            BEGIN
                SELECT * INTO loser_target
                FROM tournament_brackets WHERE id = current_bracket.loser_parent_bracket_id;
                IF loser_target IS NOT NULL THEN
                    PERFORM resolve_bracket_bye(loser_target);
                END IF;
            END;
        END IF;
    ELSE
        -- Dead bracket: zero teams, all feeders finished (e.g. all feeders were byes)
        RAISE NOTICE 'Resolving dead bracket: bracket % has no teams and no pending feeders',
            current_bracket.id;

        -- Check if parent bracket should now resolve as bye (it lost a feeder)
        IF current_bracket.parent_bracket_id IS NOT NULL THEN
            DECLARE
                parent_bracket tournament_brackets%ROWTYPE;
            BEGIN
                SELECT * INTO parent_bracket
                FROM tournament_brackets WHERE id = current_bracket.parent_bracket_id;
                IF parent_bracket IS NOT NULL THEN
                    PERFORM resolve_bracket_bye(parent_bracket);
                END IF;
            END;
        END IF;
    END IF;

    -- Check if tournament is now complete
    SELECT ts.tournament_id INTO tournament_id
    FROM tournament_stages ts
    WHERE ts.id = current_bracket.tournament_stage_id;

    IF tournament_id IS NOT NULL THEN
        PERFORM check_tournament_finished(tournament_id);
    END IF;

    RETURN true;
END;
$$;
